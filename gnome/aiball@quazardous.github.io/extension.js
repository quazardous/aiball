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
import {TAILNET, aiballTailnetUrl, tailnetMenu, tailscaleConnection, tailscaleProvider} from './tailscaleState.js';
import {HEALTH_PATH, ICON_LOCAL, NODE_PATH, actionLabel, daemonView, presentation} from './nodeState.js';

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
const BOARD_PORT = 7777;
const BOARD_URL = `http://127.0.0.1:${BOARD_PORT}/`;
// A proxy node relays reads to a remote that may hang rather than refuse: without
// a deadline, every tick would leave one more request waiting inside the shell.
const READ_TIMEOUT_MS = 2000;
const COUNTERS_TIMEOUT_MS = 5000;

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
        this._boardUrl = BOARD_URL;
        this._presentation = null;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        // The tray's logo, redrawn in one colour. The `-symbolic` file name
        // makes the shell recolour it with the panel theme, like any system icon.
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/${ICON_LOCAL}`),
            style_class: 'system-status-icon',
        });
        this._iconFile = ICON_LOCAL;
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
            // On a proxy node this is the REMOTE board: the relay serves a landing page.
            Gio.AppInfo.launch_default_for_uri(this._boardUrl, null);
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

        // #2251 — the tailnet, shown only when a tailscale provider is
        // configured, and read when the menu opens. No "take it down" entry:
        // see tailscaleState.js.
        this._tailnetSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._tailnetSeparator);
        this._tailnetItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._tailnetItem);
        this._tailnetUrl = null;
        this._tailnetOpen = this._addAction('Open on the tailnet', () => {
            if (this._tailnetUrl) Gio.AppInfo.launch_default_for_uri(this._tailnetUrl, null);
        });
        this._tailnetCopy = this._addAction('Copy the tailnet URL', () => {
            if (this._tailnetUrl) St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._tailnetUrl);
        });
        this._tailnetExpose = this._addAction('Expose on the tailnet',
            () => this._runThen(TAILNET.expose, () => this._refreshTailnet()));
        this._showTailnet(tailnetMenu({provider: null}));

        // The one refresh that is always worth paying for: the menu is open,
        // so somebody is actually reading the numbers.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._refreshHealth();
                this._refreshCounters();
                this._refreshAutostart();
                this._refreshTailnet();
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

    /** Run `argv` and resolve with its stdout, or null when it cannot run or fails to answer. */
    _capture(argv) {
        return new Promise((resolve) => {
            try {
                const proc = Gio.Subprocess.new(argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
                proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
                    try {
                        resolve(p.communicate_utf8_finish(res)[1]);
                    } catch {
                        resolve(null);
                    }
                });
            } catch {
                // The command is not installed on this machine.
                resolve(null);
            }
        });
    }

    async _refreshTailnet() {
        const provider = tailscaleProvider(await this._capture(TAILNET.providers));
        if (this._cancellable.is_cancelled()) return;
        if (!provider) {
            this._showTailnet(tailnetMenu({provider: null}));
            return;
        }
        const [status, serve] = await Promise.all([
            this._capture(TAILNET.status),
            this._capture(TAILNET.serve),
        ]);
        if (this._cancellable.is_cancelled()) return;
        this._showTailnet(tailnetMenu({
            provider,
            connection: tailscaleConnection(status),
            url: aiballTailnetUrl(serve, BOARD_PORT, provider.path),
        }));
    }

    _showTailnet(state) {
        for (const item of [this._tailnetSeparator, this._tailnetItem, this._tailnetOpen,
            this._tailnetCopy, this._tailnetExpose])
            item.visible = state.visible;
        this._tailnetUrl = state.url;
        if (!state.visible) return;
        this._tailnetItem.label.text = state.line;
        this._tailnetOpen.setSensitive(!!state.url);
        this._tailnetCopy.setSensitive(!!state.url);
        this._tailnetExpose.setSensitive(state.canExpose);
    }

    /** GET `path` on the socket, or null when it fails or outlasts `timeoutMs`. */
    async _getJson(path, timeoutMs = READ_TIMEOUT_MS) {
        const cancellable = new Gio.Cancellable();
        const link = this._cancellable.connect(() => cancellable.cancel());
        let fired = false;
        const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            fired = true;
            cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
        try {
            return await getJson(this._socketPath, path, cancellable);
        } catch {
            return null;
        } finally {
            if (!fired) GLib.source_remove(timer);
            this._cancellable.disconnect(link);
        }
    }

    async _refreshHealth() {
        // Local first: /api/node is never relayed, while /api/health on a proxy
        // node answers for the remote. A daemon that is down is the normal case,
        // not an error: it is exactly what this indicator exists to show.
        const node = await this._getJson(NODE_PATH);
        const health = await this._getJson(HEALTH_PATH);
        if (this._cancellable.is_cancelled()) return;
        this._applyView(daemonView(node, health));
    }

    async _refreshCounters() {
        const projects = await this._getJson('/api/projects?detailed=1', COUNTERS_TIMEOUT_MS);
        if (this._cancellable.is_cancelled()) return;
        if (!Array.isArray(projects)) {
            this._setCounts(null);
            return;
        }
        let pending = 0, actionable = 0, open = 0, loops = 0;
        for (const p of projects) {
            pending += p.pending_count ?? 0;
            actionable += p.actionable_count ?? 0;
            open += p.open_count ?? 0;
            if (p.running) loops += 1;
        }
        this._setCounts({pending, actionable, open, loops});
    }

    _applyView(view) {
        const p = presentation(view, BOARD_URL);
        const proxy = view.state.startsWith('proxy');
        this._presentation = p;
        this._up = p.localUp;
        this._boardUrl = p.boardUrl;
        for (const {action, item} of this._actionItems) {
            item.label.text = actionLabel(action.label, proxy);
            item.setSensitive(isActionSensitive(action, p.localUp));
        }
        this._stateItem.label.text = p.stateLine;
        // The logo either way — with the uplink arrow on a proxy node — and a
        // colour for trouble: red when the local daemon is down, orange when
        // only a proxy node's remote is.
        if (this._iconFile !== p.icon) {
            this._iconFile = p.icon;
            this._icon.gicon = Gio.icon_new_for_string(`${this._extension.path}/icons/${p.icon}`);
        }
        for (const cls of ['aiball-down', 'aiball-upstream-down'])
            this._icon.remove_style_class_name(cls);
        if (p.styleClass) this._icon.add_style_class_name(p.styleClass);
        if (!p.showCounts) {
            this._label.visible = false;
            this._countsItem.visible = false;
        }
    }

    _setCounts(counts) {
        if (!counts || this._presentation?.showCounts === false) {
            this._countsItem.visible = false;
            this._label.visible = false;
            return;
        }
        this._countsItem.visible = true;
        this._countsItem.label.text =
            `${this._presentation?.countsPrefix ?? ''}${counts.pending} to moderate · ${counts.actionable} actionable · ${counts.open} open`
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
