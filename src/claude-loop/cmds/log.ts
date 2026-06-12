/**
 * #944 Slice 3 — `claude-loop log [name] [opts]` : NDJSON-aware viewer
 * of the unified loop log (timer ticks + hook fires interleaved). The
 * underlying file is `timerLogPath(stateDirFor(name))` — the Slice 1
 * UDS merge guarantees every line lands there (the hook's local
 * `stop-hook.log` is a cold-boot safety dup, intentionally ignored
 * here).
 *
 * Filters compose : `--level info --tag '^wakeMachine' --grep delivered`
 * = NDJSON records whose level >= info AND tag matches AND msg contains
 * "delivered". `--since 5m` cuts on ts ; `--follow` tails forever.
 *
 * Pretty-print default :
 *
 *     2026-06-12T10:00:00.123Z INFO  [claude-loop:foo] wakeMachine: wake:delivered phrase='Engage!'
 *
 * `--json` keeps raw NDJSON for piping into jq.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
    stateDirFor,
    timerLogPath,
} from "../state.js";
import { LEVELS, type LogLevel, type LogRecord, parseLevel } from "../../log.js";

function die(msg: string): never {
    process.stderr.write(`claude-loop: ${msg}\n`);
    process.exit(1);
}

export interface LogOpts {
    follow?: boolean;
    lines?: string;
    level?: string;
    tag?: string;
    grep?: string;
    since?: string;
    json?: boolean;
    copy?: string;
}

const SEVERITY: Record<LogLevel, number> = {
    debug: 0, info: 1, notice: 2, warning: 3, error: 4, critical: 5, alert: 6, emergency: 7,
};

/** Parse `--since`. Accepts ISO 8601 (`2026-06-12T10:00:00Z`) or a relative
 *  duration (`5m`, `2h`, `30s`, `7d`). Returns epoch ms ; null = no filter. */
export function parseSince(s: string | undefined): number | null {
    if (!s) return null;
    const rel = /^(\d+)(s|m|h|d)$/.exec(s);
    if (rel) {
        const n = Number(rel[1]);
        const unit = rel[2];
        const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
        return Date.now() - (n * mult);
    }
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
    die(`--since: cannot parse '${s}' (try ISO 8601 or '5m' / '2h' / '30s' / '7d')`);
}

interface ParsedLine {
    rec: LogRecord | null;     // null = malformed / not-NDJSON
    raw: string;
}

function parseLine(raw: string): ParsedLine {
    if (!raw.startsWith("{")) return { rec: null, raw };
    try {
        const rec = JSON.parse(raw) as LogRecord;
        return { rec, raw };
    } catch {
        return { rec: null, raw };
    }
}

/** Test a parsed record against the configured filters. Lines that fail
 *  to parse as NDJSON are KEPT (pre-NDJSON tail in the file) so the
 *  history stays continuous. */
function matchesFilters(p: ParsedLine, opts: {
    threshold: number | null;
    tagRe: RegExp | null;
    grepRe: RegExp | null;
    sinceMs: number | null;
}): boolean {
    if (!p.rec) return true; // legacy / non-NDJSON line — keep
    const { rec } = p;
    if (opts.threshold !== null) {
        const sev = SEVERITY[rec.level] ?? -1;
        if (sev < opts.threshold) return false;
    }
    if (opts.tagRe && !opts.tagRe.test(rec.tag ?? "")) return false;
    if (opts.grepRe && !opts.grepRe.test(rec.msg)) return false;
    if (opts.sinceMs !== null) {
        const ts = Date.parse(rec.ts);
        if (!Number.isFinite(ts) || ts < opts.sinceMs) return false;
    }
    return true;
}

const LEVEL_PAD = Math.max(...LEVELS.map((l) => l.length));

function pretty(p: ParsedLine): string {
    if (!p.rec) return p.raw; // pass through legacy lines unchanged
    const { rec } = p;
    const level = rec.level.toUpperCase().padEnd(LEVEL_PAD);
    const tag = rec.tag ? `[${rec.tag}] ` : "";
    return `${rec.ts} ${level} ${tag}${rec.msg}`;
}

export async function cmdLog(name: string, opts: LogOpts): Promise<void> {
    const sd = stateDirFor(name);
    const path = timerLogPath(sd);

    // #919 david `pqs8us` : `--copy <out>` snapshots the current log file
    // to `<out>` and exits. Lets an investigation work on a frozen copy
    // instead of fighting live appends (no chasing the tail across N runs
    // of awk / grep filters). Ignores every other filter — they belong
    // on the read of the snapshot, not on the snapshot itself.
    if (opts.copy) {
        if (!existsSync(path)) die(`no log at ${path}`);
        const out = resolvePath(opts.copy);
        copyFileSync(path, out);
        process.stderr.write(`copied ${path} → ${out}\n`);
        return;
    }

    const lines = Math.max(1, Math.min(10_000, Number(opts.lines ?? "50")));

    const threshold = opts.level
        ? SEVERITY[parseLevel(opts.level) ?? die(`--level: unknown '${opts.level}'`)]
        : null;
    const tagRe = opts.tag ? new RegExp(opts.tag) : null;
    const grepRe = opts.grep ? new RegExp(opts.grep) : null;
    const sinceMs = parseSince(opts.since);

    const filterOpts = { threshold, tagRe, grepRe, sinceMs };
    const render = opts.json ? (p: ParsedLine) => p.raw : pretty;

    if (!existsSync(path)) {
        if (!opts.follow) die(`no log at ${path}`);
        // Follow mode : tail -F handles a not-yet-existent file.
    }

    if (!opts.follow) {
        const all = readFileSync(path, "utf8").split("\n");
        const filtered: string[] = [];
        for (const raw of all) {
            if (!raw) continue;
            const p = parseLine(raw);
            if (!matchesFilters(p, filterOpts)) continue;
            filtered.push(render(p));
        }
        for (const out of filtered.slice(-lines)) process.stdout.write(`${out}\n`);
        return;
    }

    // Follow mode : delegate the tail-F mechanics to /usr/bin/tail (same
    // pattern as cmdTail), apply our filters in-stream on each chunk.
    await new Promise<void>((resolveP, rejectP) => {
        const child = spawn("tail", ["-n", String(lines), "-F", path], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        // Drop the "file truncated" / "no such file" tail chatter onto
        // stderr (matches cmdTail behavior — see cmds/tail.ts).
        child.stderr?.on("data", () => { /* swallow */ });
        let carry = "";
        child.stdout?.on("data", (chunk: Buffer) => {
            const text = carry + chunk.toString("utf8");
            const out = text.split("\n");
            carry = out.pop() ?? "";
            for (const raw of out) {
                if (!raw) continue;
                const p = parseLine(raw);
                if (!matchesFilters(p, filterOpts)) continue;
                process.stdout.write(`${render(p)}\n`);
            }
        });
        child.stdout?.on("end", () => {
            if (carry) {
                const p = parseLine(carry);
                if (matchesFilters(p, filterOpts)) process.stdout.write(`${render(p)}\n`);
            }
        });
        child.on("error", rejectP);
        child.on("exit", (code) => code === 0 || code === null ? resolveP() : rejectP(new Error(`tail exited ${code}`)));
        process.on("SIGINT", () => { child.kill("SIGINT"); process.exit(0); });
    });
}
