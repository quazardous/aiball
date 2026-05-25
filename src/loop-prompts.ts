/**
 * #451 — file spool for operator → loop raw prompts. A prompt is SPOOLED (one
 * file per prompt under `$AIBALL_HOME/loop-prompts/<consumer>/`) then DELIVERED:
 * if the loop is live it's drained immediately onto its SSE; if it's offline the
 * files wait and are drained when the loop's SSE (re)connects. File-based (like
 * the client outbox spool) so it survives a daemon restart and needs no schema /
 * migration. Draining deletes the file — drained == delivered.
 *
 * Pure FS + AIBALL_HOME, so it unit-tests with a temp home (no daemon).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

function spoolRoot(): string {
    const home = process.env.AIBALL_HOME ?? join(homedir(), ".local", "share", "aiball");
    return join(home, "loop-prompts");
}

/** Per-consumer spool dir. consumer_id is sanitised for the filesystem. */
function consumerDir(consumer: string): string {
    const safe = consumer.replace(/[^a-zA-Z0-9._-]/g, "_") || "_";
    return join(spoolRoot(), safe);
}

/** Persist a prompt for a consumer (oldest-first ordering via the ts prefix). */
export function spoolPrompt(consumer: string, text: string): void {
    const dir = consumerDir(consumer);
    mkdirSync(dir, { recursive: true });
    // ts prefix → readdir().sort() is chronological; rand suffix avoids collisions.
    const name = `${Date.now()}-${randomBytes(4).toString("hex")}.txt`;
    writeFileSync(join(dir, name), text, "utf8");
}

/**
 * Read every spooled prompt for a consumer (oldest first), DELETE each, and
 * return the texts. Drained == delivered: the caller pushes them onto the loop's
 * SSE. Best-effort per file (a read/delete miss is skipped, not thrown).
 */
export function drainPrompts(consumer: string): string[] {
    const dir = consumerDir(consumer);
    if (!existsSync(dir)) return [];
    let files: string[];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".txt")).sort(); }
    catch { return []; }
    const out: string[] = [];
    for (const f of files) {
        const p = join(dir, f);
        try {
            out.push(readFileSync(p, "utf8"));
            rmSync(p, { force: true });
        } catch { /* skip a file we can't read/remove */ }
    }
    return out;
}

/** How many prompts are spooled (undelivered) for a consumer — for the UI. */
export function countSpooledPrompts(consumer: string): number {
    const dir = consumerDir(consumer);
    if (!existsSync(dir)) return 0;
    try { return readdirSync(dir).filter((f) => f.endsWith(".txt")).length; }
    catch { return 0; }
}
