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
    // #2588 — the update itself: a dry run builds the confirmation, then it runs.
    dryRun: ['aiball', '--json', 'update', '--dry-run'],
    install: ['aiball', '--json', 'update', '--yes'],
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

/**
 * #2588 — the confirmation for "Install the update", from `aiball --json update
 * --dry-run`. `ok: false` means it cannot run from here (no recorded install, a
 * dev checkout off main or with uncommitted changes): the dialog says why and
 * gives the command, and offers no install button.
 */
export function installConfirmation(dry) {
    if (!dry || typeof dry !== 'object')
        return {ok: false, title: 'Cannot update from here', body: 'aiball update did not answer.', button: null};
    if (!dry.ok) {
        return {
            ok: false,
            title: 'Cannot update from here',
            body: `${dry.reason}.\n\nBy hand:\n${dry.command}`,
            button: null,
        };
    }
    const loops = Array.isArray(dry.loops) ? dry.loops : [];
    const cut = loops.length
        ? `The daemon restarts: this disconnects ${loops.length} agent loop${loops.length > 1 ? 's' : ''} (${loops.join(', ')}).`
        : 'The daemon restarts. No agent loop is connected.';
    return {
        ok: true,
        title: 'Install the aiball update?',
        body: `${cut}\n\nRuns (${dry.mode} install):\n${dry.command}`,
        button: 'Install and restart',
    };
}

/** #2588 — the notification once `aiball --json update --yes` has returned. */
export function updateResult(text) {
    let r = null;
    try {
        r = JSON.parse(String(text ?? ''));
    } catch {
        // No JSON: the command could not run at all.
    }
    const st = r?.status;
    if (st?.state === 'ok') return 'aiball updated.';
    if (st?.state === 'failed') return `aiball update failed at ${st.failed_step} (${st.error}). Log: ${st.log}`;
    if (r && r.ok === false) return `aiball cannot update from here: ${r.reason}.`;
    return 'aiball update did not report a result — see ~/.local/share/aiball/update.log';
}
