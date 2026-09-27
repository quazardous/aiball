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
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';

import {defaultSocketPath, getJson} from './aiballClient.js';
import {AiballBus} from './aiballBus.js';
import {movesCounters, refreshDelay, sumCounts, tickReads} from './countersState.js';
import {ACTIONS, AUTOSTART, autostartFromIsEnabled, isActionSensitive} from './daemonActions.js';
import {TAILNET, aiballTailnetUrl, tailnetMenu, tailscaleConnection, tailscaleProvider} from './tailscaleState.js';
import {HEALTH_PATH, ICON_LOCAL, NODE_PATH, actionLabel, daemonView, presentation} from './nodeState.js';
import {VERSION, installConfirmation, parseVersion, updateResult, versionMenu} from './versionState.js';

/*
 * Two reads, because they do not cost the same thing.
 *
 * `/api/health` answers in ~1.5 ms, so asking every five seconds is free and
 * liveness stays responsive. The counters (`project.list` on the bus) cost
 * 150-220 ms on a real board, and the daemon serves callers one at a time. So
 * they are read when the board's events say something moved them
 * (countersState.js decides which, and how often at most), and when the menu
 * OPENS: the number you read is fresh at the moment you read it. Without the
 * events — the bus down, or a daemon that refuses the subscription — the
 * 30-second tick reads them instead.
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
        this._bus = null;
        this._connecting = null;
        this._subscribed = false;
        this._lastReadAt = null;
        this._readSource = 0;
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

        // #2586 — the version, and an update when one is out: read from
        // `aiball version`, which knows how this machine was installed.
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._versionItem = new PopupMenu.PopupMenuItem('version…', {reactive: false});
        this.menu.addMenuItem(this._versionItem);
        this._version = versionMenu(null);
        this._notifiedVersion = null;
        this._versionCopy = this._addAction('Copy the update command', () => {
            if (this._version.command)
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._version.command);
        });
        // #2588 — run it: a dry run builds the confirmation, which names the
        // loops the restart disconnects; nothing runs without that click.
        this._versionInstall = this._addAction('Install the update', () => this._confirmInstall());
        this._updating = false;
        this._versionNotes = this._addAction('Release notes', () => {
            if (this._version.releaseUrl) Gio.AppInfo.launch_default_for_uri(this._version.releaseUrl, null);
        });
        this._addAction('Check for updates', () => this._refreshVersion(VERSION.check));
        this._showVersion(this._version);

        // The one refresh that is always worth paying for: the menu is open,
        // so somebody is actually reading the numbers.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._refreshHealth();
                this._refreshCounters();
                this._refreshAutostart();
                this._refreshTailnet();
                this._refreshVersion();
            }
        });

        this._refreshHealth();
        this._refreshCounters();
        this._refreshAutostart();
        this._refreshVersion();
        this._healthSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, HEALTH_INTERVAL_S, () => {
                this._refreshHealth();
                return GLib.SOURCE_CONTINUE;
            });
        this._countersSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, COUNTERS_INTERVAL_S, () => {
                if (tickReads(Date.now(), this._lastReadAt, this._subscribed))
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

    async _refreshVersion(argv = VERSION.read) {
        const text = await this._capture(argv);
        if (this._cancellable.is_cancelled()) return;
        this._showVersion(versionMenu(parseVersion(text)));
    }

    async _confirmInstall() {
        const text = await this._capture(VERSION.dryRun);
        if (this._cancellable.is_cancelled()) return;
        let dry = null;
        try {
            dry = JSON.parse(text ?? '');
        } catch {
            // Shown as "did not answer" below.
        }
        const c = installConfirmation(dry);
        const dialog = new ModalDialog.ModalDialog();
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({title: c.title, description: c.body}));
        const buttons = [{label: c.ok ? 'Cancel' : 'Close', action: () => dialog.close()}];
        if (c.ok) {
            buttons.push({
                label: c.button,
                action: () => {
                    dialog.close();
                    this._runInstall();
                },
            });
        }
        dialog.setButtons(buttons);
        dialog.open();
    }

    async _runInstall() {
        this._updating = true;
        this._showVersion(this._version);
        const text = await this._capture(VERSION.install);
        if (this._cancellable.is_cancelled()) return;
        this._updating = false;
        Main.notify('aiball', updateResult(text));
        this._refreshHealth();
        this._refreshVersion();
    }

    _showVersion(state) {
        this._version = state;
        this._versionItem.label.text = state.line;
        this._versionCopy.visible = !!state.command;
        this._versionInstall.visible = !!state.command || this._updating;
        this._versionInstall.label.text = this._updating ? 'Updating…' : 'Install the update';
        this._versionInstall.setSensitive(!this._updating);
        this._versionNotes.visible = !!state.releaseUrl;
        // One notification per release, not one per refresh.
        if (state.notifyKey && state.notifyKey !== this._notifiedVersion) {
            this._notifiedVersion = state.notifyKey;
            Main.notify('aiball', `${state.line}. The menu copies the update command for this install.`);
        }
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
        this._lastReadAt = Date.now();
        const bus = await this._connectBus();
        let projects = null;
        if (bus) {
            try {
                projects = await this._deadline(bus.call('project.list', {detailed: true}), COUNTERS_TIMEOUT_MS);
            } catch {
                projects = null;
            }
        }
        if (this._cancellable.is_cancelled()) return;
        this._setCounts(sumCounts(projects));
    }

    /**
     * The bus, connected and subscribed to the board's events; null while the
     * daemon is down. One attempt at a time: reads that arrive meanwhile wait
     * for it.
     */
    _connectBus() {
        if (this._bus?.open) return Promise.resolve(this._bus);
        if (this._connecting) return this._connecting;
        this._connecting = (async () => {
            let bus;
            try {
                bus = await AiballBus.connect(this._socketPath, {
                    onEvent: (event) => this._onBoardEvent(event),
                    onClosed: () => {
                        if (this._bus === bus) {
                            this._bus = null;
                            this._subscribed = false;
                        }
                    },
                    timeoutMs: READ_TIMEOUT_MS,
                });
            } catch {
                this._connecting = null;
                return null;
            }
            if (this._cancellable.is_cancelled()) {
                bus.close();
                this._connecting = null;
                return null;
            }
            this._bus = bus;
            try {
                await this._deadline(bus.call('bus.subscribe', {subject: 'board.events'}), READ_TIMEOUT_MS);
                this._subscribed = true;
            } catch {
                // Calls still work; the tick reads the counters instead.
                this._subscribed = false;
            }
            this._connecting = null;
            return bus;
        })();
        return this._connecting;
    }

    /** A board event: read the counters again soon if it may have moved them. */
    _onBoardEvent(event) {
        if (this._cancellable.is_cancelled() || !movesCounters(event)) return;
        const delay = refreshDelay(Date.now(), this._lastReadAt, this._readSource !== 0);
        if (delay === null) return;
        this._readSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._readSource = 0;
            this._refreshCounters();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** `promise`, or a rejection once `timeoutMs` has passed. */
    _deadline(promise, timeoutMs) {
        return new Promise((resolve, reject) => {
            let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                timer = 0;
                reject(new Error('timed out'));
                return GLib.SOURCE_REMOVE;
            });
            const done = () => {
                if (timer) GLib.source_remove(timer);
                timer = 0;
            };
            promise.then((v) => { done(); resolve(v); }, (e) => { done(); reject(e); });
        });
    }

    _applyView(view) {
        const p = presentation(view, BOARD_URL);
        const proxy = view.state.startsWith('proxy');
        this._presentation = p;
        // A daemon that just came up may run another version: read it again.
        if (p.localUp && this._up === false) this._refreshVersion();
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
        if (this._readSource) GLib.source_remove(this._readSource);
        this._healthSource = 0;
        this._countersSource = 0;
        this._readSource = 0;
        this._bus?.close();
        this._bus = null;
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
