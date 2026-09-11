/*
 * What the menu can DO to the daemon, as data — and deliberately import-free
 * (no `gi://`, no `resource://`), so a plain Node test can load this file and
 * pin the commands without a GNOME Shell.
 *
 * Every entry is a button the user presses. Nothing here runs on its own: the
 * extension still does not supervise the daemon, `systemctl --user` does.
 * Start and stop go through systemd for the same reason: the unit is the one
 * thing that owns the process, and a second path to it could disagree with it.
 */

export const SERVICE = 'aiball';

/**
 * `when` says in which daemon state the action makes sense: `up` actions are
 * greyed out while the daemon is down, and `start` while it is up. Stop's label
 * says what it costs, because every connected loop drops with the daemon.
 */
export const ACTIONS = Object.freeze([
    {id: 'start', label: 'Start the daemon', argv: ['systemctl', '--user', 'start', SERVICE], when: 'down'},
    {id: 'stop', label: 'Stop the daemon — disconnects every loop', argv: ['systemctl', '--user', 'stop', SERVICE], when: 'up'},
    {id: 'restart', label: 'Restart the daemon', argv: ['aiball', 'restart'], when: 'up'},
    {id: 'reload', label: 'Reload the config', argv: ['aiball', 'reload'], when: 'up'},
]);

/** The "Start at login" switch mirrors the unit's install state. */
export const AUTOSTART = Object.freeze({
    label: 'Start at login',
    query: ['systemctl', '--user', 'is-enabled', SERVICE],
    enable: ['systemctl', '--user', 'enable', SERVICE],
    disable: ['systemctl', '--user', 'disable', SERVICE],
});

/**
 * Whether an action's menu item is clickable. `up` is `true`, `false`, or
 * `null` before the first health read — unknown leaves everything clickable
 * rather than guessing wrong.
 */
export function isActionSensitive(action, up) {
    if (up === null || up === undefined) return true;
    return action.when === 'up' ? up : !up;
}

/**
 * `systemctl is-enabled` prints the state on stdout and exits non-zero for
 * anything but enabled, so the text is the answer. Only `enabled` starts the
 * daemon at login; `disabled`, `static`, `masked`… do not.
 */
export function autostartFromIsEnabled(stdout) {
    return String(stdout ?? '').trim() === 'enabled';
}
