/**
 * `claude-loop tail` command + its private helpers (carved out of
 * cli.ts in #B.213 phase 2.A on 2026-05-19). Behavior-preserving move.
 *
 * Exports:
 *   - `cmdTail(name, lines, which, follow)` — the command handler
 *   - `TailMode` — `"pane" | "timer" | "stop-hook" | "log"`
 *
 * Local helpers (`paneDelta`, `followPane`, `TAIL_NOISE_RE`,
 * `pipeFilteredStderr`, `followFile`) stay private to this module —
 * they only matter for the tail flow.
 *
 * `die` + `tmuxAlive` are duplicated as tiny inlined helpers rather
 * than imported from cli.ts to keep the extraction self-contained and
 * avoid creating a circular import. They're 3-5 lines each.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    MUX_CMD,
    stateDirFor,
    timerLogPath,
    tmuxName,
} from "../state.js";

function die(msg: string): never {
    process.stderr.write(`claude-loop: ${msg}\n`);
    process.exit(1);
}

function tmuxAlive(name: string): boolean {
    const r = spawnSync(MUX_CMD, ["has-session", "-t", tmuxName(name)], { stdio: "ignore" });
    return r.status === 0;
}

export type TailMode = "pane" | "timer" | "stop-hook" | "log";

/**
 * Print lines that appeared in `now` but weren't in `prev` (#B.198
 * follow). The pane buffer scrolls, so we anchor by finding the
 * longest suffix of `prev` that matches a prefix of `now` — anything
 * past that anchor is new content. Empty `prev` → first poll, dump
 * everything. No overlap → content scrolled past faster than we
 * polled, dump everything (best-effort, missed lines stay lost).
 */
function paneDelta(prev: string, now: string): string {
    if (!prev) return now;
    if (prev === now) return "";
    const a = prev.split("\n");
    const b = now.split("\n");
    for (let k = Math.min(a.length, b.length); k > 0; k--) {
        let match = true;
        for (let i = 0; i < k; i++) {
            if (a[a.length - k + i] !== b[i]) { match = false; break; }
        }
        if (match) return b.slice(k).join("\n");
    }
    return now;
}

async function followPane(name: string, lines: number): Promise<void> {
    let prev = "";
    let printedInitial = false;
    // Best-effort cleanup on Ctrl-C — let the SIGINT propagate.
    process.on("SIGINT", () => process.exit(0));
    while (true) {
        if (!tmuxAlive(name)) die(`loop '${name}' no longer alive`);
        const r = spawnSync(MUX_CMD, ["capture-pane", "-t", `${tmuxName(name)}.0`, "-p"], {
            encoding: "utf8",
        }) as SpawnSyncReturns<string>;
        if (r.status !== 0) die(`capture-pane failed for ${tmuxName(name)}`);
        const buf = r.stdout ?? "";
        if (!printedInitial) {
            const all = buf.split("\n");
            process.stdout.write(all.slice(-lines).join("\n") + "\n");
            prev = buf;
            printedInitial = true;
        } else {
            const delta = paneDelta(prev, buf);
            if (delta) {
                process.stdout.write(delta + (delta.endsWith("\n") ? "" : "\n"));
                prev = buf;
            }
        }
        await new Promise((res) => setTimeout(res, 500));
    }
}

/**
 * GNU tail prints chatty status lines on stderr when a watched file
 * disappears (claude-loop restart deletes the session's state dir):
 * "became inaccessible" / "est devenu inaccessible", "cannot use
 * inotify" / "impossible d'utiliser inotify", "reverting to polling"
 * / "retour à l'interrogation active". Tail itself keeps working via
 * polling — these are warnings, not errors — but they clutter the
 * `claude-loop --log` view. #B.210. We drop the known noise and let
 * any other stderr (real errors) through.
 */
const TAIL_NOISE_RE =
    /became inaccessible|est devenu inaccessible|cannot use inotify|impossible d'utiliser inotify|reverting to polling|retour à l'interrogation active|le répertoire contenant le fichier|directory containing the watched file|tail: cannot open .* for reading: No such file or directory|tail: impossible d'ouvrir .* en lecture: Aucun fichier ou dossier de ce nom/i;

function pipeFilteredStderr(child: import("node:child_process").ChildProcess): void {
    if (!child.stderr) return;
    let carry = "";
    child.stderr.on("data", (chunk: Buffer) => {
        const text = carry + chunk.toString("utf8");
        const out = text.split("\n");
        carry = out.pop() ?? "";
        for (const l of out) {
            if (!l) continue;
            if (TAIL_NOISE_RE.test(l)) continue;
            process.stderr.write(`${l}\n`);
        }
    });
    child.stderr.on("end", () => {
        if (carry && !TAIL_NOISE_RE.test(carry)) process.stderr.write(`${carry}\n`);
    });
}

function followFile(path: string, lines: number, prefix?: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn("tail", ["-n", String(lines), "-F", path], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        pipeFilteredStderr(child);
        if (child.stdout) {
            let carry = "";
            child.stdout.on("data", (chunk: Buffer) => {
                const text = carry + chunk.toString("utf8");
                const lines = text.split("\n");
                carry = lines.pop() ?? "";
                for (const l of lines) process.stdout.write(`${prefix ?? ""}${l}\n`);
            });
            child.stdout.on("end", () => { if (carry) process.stdout.write(`${prefix ?? ""}${carry}\n`); });
        }
        child.on("error", reject);
        child.on("exit", (code) => code === 0 || code === null ? resolve() : reject(new Error(`tail exited ${code}`)));
        process.on("SIGINT", () => { child.kill("SIGINT"); process.exit(0); });
    });
}

export async function cmdTail(name: string, lines: number, which: TailMode, follow: boolean): Promise<void> {
    if (which === "timer" || which === "stop-hook") {
        const log = which === "timer"
            ? timerLogPath(stateDirFor(name))
            : join(stateDirFor(name), "stop-hook.log");
        const label = which === "timer" ? "timer log" : "stop-hook log";
        if (!existsSync(log)) {
            if (!follow) die(`no ${label} at ${log}`);
            // Follow mode: tail -F handles a not-yet-existent file
            // (waits for it to appear). Helpful when the Stop hook
            // hasn't fired yet — user can leave it running.
        }
        if (!follow) {
            const all = readFileSync(log, "utf8").split("\n");
            process.stdout.write(all.slice(-lines).join("\n") + "\n");
            return;
        }
        await followFile(log, lines, undefined);
        return;
    }
    if (which === "log") {
        const sd = stateDirFor(name);
        const timer = timerLogPath(sd);
        const hook = join(sd, "stop-hook.log");
        // Prefixes name the source explicitly (#B.198, david: "il
        // faut quand meme dire le nom du hook"). Order is now
        // `<timestamp> <tag> <rest>` (david: "ça serait plus pratique
        // cet ordre heure [type event]"): we pull any leading ISO
        // timestamp out of the body line and reinject it BEFORE the
        // tag, so all sources show one consistent time column.
        const TIMER_TAG = "[timer]    ";
        const HOOK_TAG  = "[stop-hook]";
        const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+/;
        function reformat(line: string, tag: string): string {
            const m = ISO_RE.exec(line);
            if (m) return `${m[1]} ${tag} ${line.slice(m[0].length)}`;
            // No leading timestamp (older/foreign lines) — synthesize
            // a placeholder so columns still line up.
            return `${" ".repeat(24)} ${tag} ${line}`;
        }
        if (!follow) {
            for (const [p, tag] of [[timer, TIMER_TAG], [hook, HOOK_TAG]] as const) {
                if (!existsSync(p)) continue;
                const all = readFileSync(p, "utf8").split("\n");
                for (const l of all.slice(-lines)) process.stdout.write(`${reformat(l, tag)}\n`);
            }
            return;
        }
        const runFollow = async (path: string, tag: string): Promise<void> => {
            return new Promise((resolveP, rejectP) => {
                const child = spawn("tail", ["-n", String(lines), "-F", path], {
                    stdio: ["ignore", "pipe", "pipe"],
                });
                pipeFilteredStderr(child);
                let carry = "";
                child.stdout?.on("data", (chunk: Buffer) => {
                    const text = carry + chunk.toString("utf8");
                    const out = text.split("\n");
                    carry = out.pop() ?? "";
                    for (const l of out) process.stdout.write(`${reformat(l, tag)}\n`);
                });
                child.stdout?.on("end", () => {
                    if (carry) process.stdout.write(`${reformat(carry, tag)}\n`);
                });
                child.on("error", rejectP);
                child.on("exit", (code) => code === 0 || code === null ? resolveP() : rejectP(new Error(`tail exited ${code}`)));
                process.on("SIGINT", () => { child.kill("SIGINT"); process.exit(0); });
            });
        };
        await Promise.race([
            runFollow(timer, TIMER_TAG),
            runFollow(hook, HOOK_TAG),
        ]);
        return;
    }
    // pane mode
    if (!tmuxAlive(name)) {
        die(`loop '${name}' not alive (use --timer / --stop-hook / --log to inspect logs instead)`);
    }
    if (!follow) {
        const r = spawnSync(MUX_CMD, ["capture-pane", "-t", `${tmuxName(name)}.0`, "-p"], {
            encoding: "utf8",
        }) as SpawnSyncReturns<string>;
        if (r.status !== 0) die(`capture-pane failed for ${tmuxName(name)}`);
        const all = (r.stdout ?? "").split("\n");
        process.stdout.write(all.slice(-lines).join("\n") + "\n");
        return;
    }
    await followPane(name, lines);
}
