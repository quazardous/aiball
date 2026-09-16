/*
 * The version section of the menu, as pure functions — import-free like
 * nodeState.js, so a plain Node test can pin it.
 *
 * Everything comes from `aiball --json version`: the daemon's last check of the
 * latest release, and the update command for THIS install, which the CLI builds
 * from the installer's record. The extension adds no network call and no
 * knowledge of how aiball was installed; it shows what the CLI says.
 */

export const VERSION = Object.freeze({
    read: ['aiball', '--json', 'version'],
    check: ['aiball', '--json', 'version', '--check'],
});

/** The CLI's JSON, or null when it did not run or did not answer JSON. */
export function parseVersion(text) {
    try {
        const v = JSON.parse(String(text ?? ''));
        return v && typeof v === 'object' ? v : null;
    } catch {
        return null;
    }
}

/**
 * What the section shows. `line` is always there; `command` and `releaseUrl`
 * only when an update is out; `notifyKey` is the latest version worth one
 * notification (null when there is nothing to say).
 */
export function versionMenu(v) {
    const none = {line: 'version unknown', command: null, releaseUrl: null, restart: false, notifyKey: null};
    if (!v) return none;
    const d = v.daemon;
    if (!d) return {...none, line: `aiball ${v.cli} — daemon not reachable`};
    if (d.restart_needed)
        return {...none, line: `aiball ${d.running} runs, ${d.installed} is installed — restart the daemon`, restart: true};
    if (d.check_disabled) return {...none, line: `aiball ${d.running} — update check off`};
    if (d.update_available && d.latest) {
        return {
            line: `aiball ${d.running} — ${d.latest} is available`,
            command: v.update_command ?? null,
            releaseUrl: d.release_url ?? null,
            restart: false,
            notifyKey: d.latest,
        };
    }
    if (d.latest) return {...none, line: `aiball ${d.running} — up to date`};
    return {...none, line: `aiball ${d.running}${d.error ? ' — could not check for updates' : ''}`};
}
