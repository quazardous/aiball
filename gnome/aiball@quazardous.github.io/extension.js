/*
 * aiball — GNOME Shell top-bar indicator.
 *
 * Deliberately NOT a port of the Windows tray. That one polls the daemon every
 * five seconds and restarts it, because Windows has no service manager for a
 * user process. Here `systemctl --user` already does that job, better and for
 * longer; an extension that also "watched" would duplicate it and could fight
 * it. So this is visibility and shortcuts, nothing else.
 *
 * It talks to the Unix socket, never the port. That is what keeps it free of
 * any credential: same-uid access to the socket IS the trust boundary the
 * daemon recognises, and an extension already runs as that user.
 */
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {defaultSocketPath, getJson} from './aiballClient.js';
import {ACTIONS, AUTOSTART, autostartFromIsEnabled, isActionSensitive} from './daemonActions.js';

/*
 * Two cadences, because the two reads do not cost the same thing.
 *
 * `/api/health` answers in ~1.5 ms, so asking often is free and liveness stays
 * responsive. `/api/projects?detailed=1` costs 150-220 ms on a real board —
 * the daemon serves callers one at a time, so polling THAT every five seconds
 * would spend a couple of percent of it on a panel nobody is looking at.
 *
 * Hence the third rule, which matters more than either interval: the counters
 * are refreshed when the menu OPENS. The number you read is fresh at the
 * moment you read it, and the idle cost stays at 1.5 ms every five seconds.
 */
const HEALTH_INTERVAL_S = 5;
const COUNTERS_INTERVAL_S = 30;
const BOARD_URL = 'http://127.0.0.1:7777/';

const AiballIndicator = GObject.registerClass(
class AiballIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'aiball');
        this._extension = extension;
        this._socketPath = defaultSocketPath();
        this._cancellable = new Gio.Cancellable();
        this._healthSource = 0;
        this._countersSource = 0;
        this._up = null;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        // The tray's logo, redrawn in one colour. The `-symbolic` file name
        // makes the shell recolour it with the panel theme, like any system icon.
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/aiball-symbolic.svg`),
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: '',
            y_align: 2 /* Clutter.ActorAlign.CENTER */,
            style_class: 'aiball-count',
        });
        this._label.visible = false;
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._stateItem = new PopupMenu.PopupMenuItem('checking…', {reactive: false});
        this.menu.addMenuItem(this._stateItem);
        this._countsItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._countsItem.visible = false;
        this.menu.addMenuItem(this._countsItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addAction('Open the board', () => {
            Gio.AppInfo.launch_default_for_uri(BOARD_URL, null);
        });
        // #2251 — start / stop / restart / reload, each greyed out when it cannot
        // apply. Buttons, not supervision: nothing here acts on its own.
        this._actionItems = ACTIONS.map((action) => ({
            action,
            item: this._addAction(action.label, () => this._runThen(action.argv, () => this._refreshHealth())),
        }));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._autostartItem = new PopupMenu.PopupSwitchMenuItem(AUTOSTART.label, false);
        this._autostartItem.connect('toggled', (_item, on) => {
            this._runThen(on ? AUTOSTART.enable : AUTOSTART.disable, () => this._refreshAutostart());
        });
        this.menu.addMenuItem(this._autostartItem);

        // The one refresh that is always worth paying for: the menu is open,
        // so somebody is actually reading the numbers.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._refreshHealth();
                this._refreshCounters();
                this._refreshAutostart();
            }
        });

        this._refreshHealth();
        this._refreshCounters();
        this._refreshAutostart();
        this._healthSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, HEALTH_INTERVAL_S, () => {
                this._refreshHealth();
                return GLib.SOURCE_CONTINUE;
            });
        this._countersSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, COUNTERS_INTERVAL_S, () => {
                this._refreshCounters();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _addAction(label, fn) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => fn());
        this.menu.addMenuItem(item);
        return item;
    }

    /** Run `argv`, then `then()` once it exits — to re-read the state it changed. */
    _runThen(argv, then) {
        try {
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDERR_SILENCE);
            proc.wait_async(this._cancellable, () => {
                if (!this._cancellable.is_cancelled()) then();
            });
        } catch (e) {
            Main.notify('aiball', `could not run ${argv.join(' ')}: ${e.message}`);
        }
    }

    _refreshAutostart() {
        try {
            const proc = Gio.Subprocess.new(AUTOSTART.query,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    this._autostartItem.setToggleState(autostartFromIsEnabled(stdout));
                } catch {
                    // Cancelled on destroy, or systemctl missing: leave the switch as is.
                }
            });
        } catch {
            // No systemctl on this machine: the switch stays off and inert.
        }
    }

    async _refreshHealth() {
        try {
            const health = await getJson(this._socketPath, '/api/health', this._cancellable);
            this._setUp(true, health.version);
        } catch {
            // A daemon that is down is the normal case, not an error: it is
            // exactly what this indicator exists to show.
            this._setUp(false, null);
        }
    }

    async _refreshCounters() {
        try {
            const projects = await getJson(
                this._socketPath, '/api/projects?detailed=1', this._cancellable);
            let pending = 0, actionable = 0, open = 0, loops = 0;
            for (const p of projects) {
                pending += p.pending_count ?? 0;
                actionable += p.actionable_count ?? 0;
                open += p.open_count ?? 0;
                if (p.running) loops += 1;
            }
            this._setCounts({pending, actionable, open, loops});
        } catch {
            this._setCounts(null);
        }
    }

    _setUp(up, version) {
        this._up = up;
        for (const {action, item} of this._actionItems)
            item.setSensitive(isActionSensitive(action, up));
        this._stateItem.label.text = up
            ? `daemon up${version ? ` — ${version}` : ''}`
            : 'daemon down';
        // Same logo either way; down turns it red, so the brand stays and the
        // state still reads at a glance.
        if (up)
            this._icon.remove_style_class_name('aiball-down');
        else
            this._icon.add_style_class_name('aiball-down');
        if (!up) {
            this._label.visible = false;
            this._countsItem.visible = false;
        }
    }

    _setCounts(counts) {
        if (!counts) {
            this._countsItem.visible = false;
            this._label.visible = false;
            return;
        }
        this._countsItem.visible = true;
        this._countsItem.label.text =
            `${counts.pending} to moderate · ${counts.actionable} actionable · ${counts.open} open`
            + (counts.loops > 0 ? ` · ${counts.loops} loop${counts.loops > 1 ? 's' : ''}` : '');
        // The bar carries ONE number, and it is the one that wants YOU: tickets
        // waiting on a human decision. Everything else is in the menu, a click
        // away, because a bar full of numbers is a bar nobody reads.
        this._label.text = counts.pending > 0 ? ` ${counts.pending}` : '';
        this._label.visible = counts.pending > 0;
    }

    destroy() {
        // Order matters: cancel first so an in-flight read cannot land on a
        // destroyed actor, then drop the timers.
        this._cancellable.cancel();
        if (this._healthSource) GLib.source_remove(this._healthSource);
        if (this._countersSource) GLib.source_remove(this._countersSource);
        this._healthSource = 0;
        this._countersSource = 0;
        super.destroy();
    }
});

export default class AiballExtension extends Extension {
    enable() {
        this._indicator = new AiballIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
