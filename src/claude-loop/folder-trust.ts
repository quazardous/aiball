/**
 * #2230 — has Claude Code been told to trust this folder?
 *
 * Claude Code keeps one entry per folder in `~/.claude.json` (`projects.<abs
 * path>.hasTrustDialogAccepted`). A loop started in a folder without it opens
 * on the trust dialog, and with `--no-attach` nobody sees that. `start` reads
 * this to say so up front.
 *
 * Read-only on purpose: answering the dialog is the human's persistent choice,
 * and claude rewrites that file while it runs, so writing beside it would race.
 * An accepted ancestor counts, so a folder under an already-trusted tree does
 * not raise a warning it may not deserve; the pane watcher still catches the
 * dialog if Claude asks anyway.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Projects = Record<string, { hasTrustDialogAccepted?: unknown } | undefined>;

/** Pure: true when `cwd` or one of its ancestors is marked trusted. */
export function isTrustedIn(projects: Projects, cwd: string): boolean {
    let dir = cwd;
    for (;;) {
        if (projects[dir]?.hasTrustDialogAccepted === true) return true;
        const parent = dirname(dir);
        if (parent === dir) return false;
        dir = parent;
    }
}

/** `null` when the config can't be read or parsed — no warning is better than a
 *  wrong one. */
export function readFolderTrust(cwd: string, home: string = homedir()): boolean | null {
    try {
        const cfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as { projects?: Projects };
        return isTrustedIn(cfg.projects ?? {}, cwd);
    } catch {
        return null;
    }
}
