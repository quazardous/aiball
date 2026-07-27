/**
 * `claude-loop capture [<name>]` — pull pane frames on demand (#1588).
 *
 * Every text detector in the loop matches against a `capture-pane` dump, so
 * arguing about those rules means holding a real dump. Before this command
 * there was no way to get one from the outside: the capture lived inside the
 * timer process, and the only way out was to run the multiplexer's own
 * capture command by hand. That is fine on tmux and impossible on Windows,
 * where the loop runs under psmux — which left the one agent who could
 * produce Windows evidence unable to produce it.
 *
 * Going through `MUX_CMD` is the whole point: the same command works on both.
 *
 * Two sources, one output:
 *   - live (default) — capture the pane right now.
 *   - `-n <N>`       — the last N frames of the rotating cache
 *                      (`claude_loop.pane_cache_frames`), for the screens that
 *                      already scrolled past.
 *
 * Read-only. Never writes to the loop's state dir.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MUX_CMD, paneCaptureDir, stateDirFor, tmuxName } from "../state.js";

export interface CaptureOpts {
    /** Read the last N frames from the rotating cache instead of the pane. */
    last?: string;
    /** Separate frames with a `--- <filename>` banner. Implied by `--last`
     *  unless the caller asked for exactly one frame. */
    headers?: boolean;
}

/** The newest `n` cache frames, oldest first. Names are ISO stamps, so
 *  sorting the names sorts them by time. */
export function lastCachedFrames(dir: string, n: number): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith(".txt"))
        .sort()
        .slice(-n);
}

export function cmdCapture(name: string, opts: CaptureOpts = {}): void {
    const sd = stateDirFor(name);

    if (opts.last !== undefined) {
        const n = Number(opts.last);
        if (!Number.isFinite(n) || n < 1) {
            process.stderr.write(`claude-loop: --last expects a positive count, got '${opts.last}'\n`);
            process.exitCode = 1;
            return;
        }
        const dir = paneCaptureDir(sd);
        const frames = lastCachedFrames(dir, Math.floor(n));
        if (frames.length === 0) {
            // Say which knob turns it on rather than just reporting nothing —
            // an empty cache and a disabled cache look identical from here.
            process.stderr.write(
                `claude-loop: no cached frames under ${dir}\n`
                + `  the rotating cache is off unless \`claude_loop.pane_cache_frames\` is set\n`
                + `  (or CL_PANE_CAPTURE_FRAMES=<n> for one run)\n`,
            );
            process.exitCode = 1;
            return;
        }
        const withHeaders = opts.headers ?? frames.length > 1;
        for (const f of frames) {
            if (withHeaders) process.stdout.write(`--- ${f}\n`);
            try {
                process.stdout.write(readFileSync(join(dir, f), "utf8"));
            } catch (e) {
                process.stderr.write(`claude-loop: unreadable frame ${f} — ${e instanceof Error ? e.message : String(e)}\n`);
            }
        }
        return;
    }

    const r = spawnSync(MUX_CMD, ["capture-pane", "-t", `${tmuxName(name)}.0`, "-p"], { encoding: "utf8" });
    if (r.error) {
        process.stderr.write(`claude-loop: ${MUX_CMD} spawn error — ${r.error.message}\n`);
        process.exitCode = 1;
        return;
    }
    if (r.status !== 0) {
        const why = (r.stderr ?? "").split(/\r?\n/).find((l) => l.trim()) ?? `exited ${r.status ?? "on a signal"}`;
        process.stderr.write(`claude-loop: cannot capture '${name}' — ${why.trim()}\n`);
        process.exitCode = 1;
        return;
    }
    if (opts.headers) process.stdout.write(`--- live ${tmuxName(name)}\n`);
    process.stdout.write(r.stdout ?? "");
}
