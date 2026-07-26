/**
 * `claude-loop bug [name]` — build one `.tar.gz` a user can attach to a bug
 * report (#1560).
 *
 * Built ON the existing pieces rather than beside them: `captureSnapshot()`
 * collects the logs and pane-captures, `runHealthChecks()` supplies the ten
 * verdicts. What this adds is the environment, a manifest, a secret scrub,
 * and a single archive.
 *
 * **Whitelist, not denylist.** The bundle only ever contains what the snapshot
 * whitelist already collects (logs + pane-captures) plus the three files
 * written here. The state dir also holds `env`, `env.local` and
 * `claude-settings.json` — credential-shaped — and they are never copied. A
 * file dropped into the state dir tomorrow is excluded by default instead of
 * leaking by default.
 *
 * The scrub on top is **best-effort**, and MANIFEST.txt says so: it catches
 * known token shapes and `key: value` secrets, not arbitrary confidential
 * prose. `loop.log` legitimately contains ticket titles and bodies — on a
 * private project that is confidential content the scrub cannot recognise.
 * Read the archive before sending it to a stranger.
 *
 * Output path: `--out` → `claude_loop.dump_dir` → `os.tmpdir()`.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, release, type as osType } from "node:os";
import { join, relative } from "node:path";

import { stateDirFor } from "../state.js";
import { captureSnapshot } from "./snapshot.js";
import { runHealthChecks } from "./health.js";
import { loadConfig } from "../../autopoll/config.js";
import { AIBALL_VERSION } from "../../version.js";

export interface BugOpts {
    note?: string;
    out?: string;
    /** Skip the scrub. For debugging the bundler itself, never for a report
     *  you hand to someone else. */
    raw?: boolean;
    /** Include the pane captures. Off by default: a pane capture is a verbatim
     *  screen dump — source, file contents, whatever was on screen — and no
     *  scrub can make that safe to send to a stranger. Opt in when the bug is
     *  actually about pane detection, and read them first. */
    withPaneCaptures?: boolean;
}

// ---------------------------------------------------------------------------
// Secret scrub (pure — unit-tested).
// ---------------------------------------------------------------------------

/**
 * Redact known secret shapes from a text file destined for the bundle.
 *
 * Deliberately conservative about what it matches. We redact by **key name**
 * (`token: …`) and by **known vendor prefixes** (`sk-ant-…`, `ghp_…`), not by
 * generic shape: a 40-char hex run is far more likely to be a git SHA — which
 * is diagnostic gold — than a secret, and a UUID is a session id. Scrubbing
 * those would quietly destroy the value of the bundle to buy nothing.
 */
export function scrubSecrets(text: string): string {
    return text
        // Vendor-prefixed tokens, wherever they appear.
        .replace(/\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,})/g, "[REDACTED:api-key]")
        .replace(/\b(gh[pos]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED:github-token]")
        .replace(/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g, "Bearer [REDACTED]")
        // `key: value` / `key=value` where the key NAME announces a secret.
        //
        // The key may be prefixed (`upstream_auth` is the one aiball actually
        // uses for GitHub tokens), hence the leading `[\w.-]*`. The
        // `(?![a-z])` after the alternation is what keeps `author: david` out
        // of it — `auth` followed by a letter is a different word. Values
        // already handled by the rules above are skipped so we don't stack
        // redactions on top of each other.
        .replace(
            /([\w.-]*(?:authorization|api[_-]?key|credential|password|passwd|secret|token|auth)(?![a-z]))(\s*[:=]\s*)("?)((?!\[REDACTED)(?![Bb]earer\b)[^\s"',}]{6,})\3/gi,
            (_m, key: string, sep: string, q: string) => `${key}${sep}${q}[REDACTED]${q}`,
        );
}

/**
 * Redact the prompt payload out of `loop.log`'s wake lines (#1560, third-party
 * hardening).
 *
 * The log is NDJSON, and almost all of it is state-machine telemetry with no
 * project content. Two message shapes carry prose:
 *
 *     wake (turn:settled) → '<the whole wake prompt>'
 *     wakeMachine: wake:delivered phrase="<truncated prompt>" headMessageId=N
 *
 * and a wake prompt quotes **ticket titles and comment fragments verbatim**.
 * (The second one is easy to miss — grepping for the first shape alone leaves
 * titles in the bundle, which is exactly what happened here until a real
 * bundle was grepped for a known title. Verify against an archive, not against
 * a reading of the logger.)
 * On a third party's machine that is their private board, so it must not
 * travel. The diagnostic value of the line is that a wake fired and when —
 * never the text — so we keep the line and replace the payload with its
 * length. `wake:diag` lines are untouched: their `ticket=#N` is a bare number,
 * and the whole point of a wake-storm report is comparing those numbers.
 *
 * Parses line by line rather than regexing the raw text, so quoting and
 * embedded newlines are handled by the JSON parser. Unparseable lines pass
 * through untouched.
 */
export function redactLogProse(ndjson: string): string {
    return ndjson
        .split("\n")
        .map((line) => {
            if (!line.trim()) return line;
            let row: unknown;
            try { row = JSON.parse(line); } catch { return line; }
            if (typeof row !== "object" || row === null) return line;
            const rec = row as Record<string, unknown>;
            if (typeof rec.msg !== "string") return line;
            const redacted = rec.msg
                .replace(
                    /(→ ')([\s\S]*)('\s*)$/,
                    (_m, head: string, payload: string) => `${head}[redacted ${payload.length} chars]'`,
                )
                .replace(
                    /(\bphrase=")([\s\S]*)("(?=\s|$))/,
                    (_m, head: string, payload: string) => `${head}[redacted ${payload.length} chars]"`,
                );
            if (redacted === rec.msg) return line;
            return JSON.stringify({ ...rec, msg: redacted });
        })
        .join("\n");
}

/** Text files we scrub in place. Anything else in the snapshot (pane captures
 *  are text too, but may be large) gets the same treatment — the scrub is
 *  cheap and a leak in a pane capture counts just as much. */
function scrubTree(dir: string): { scrubbed: number; skipped: number } {
    let scrubbed = 0;
    let skipped = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
            const r = scrubTree(p);
            scrubbed += r.scrubbed;
            skipped += r.skipped;
            continue;
        }
        try {
            const before = readFileSync(p, "utf8");
            // Log files get the prose redaction too — that's where the wake
            // prompts, and therefore the ticket titles, live.
            const after = p.endsWith(".log")
                ? scrubSecrets(redactLogProse(before))
                : scrubSecrets(before);
            if (after !== before) writeFileSync(p, after);
            scrubbed += 1;
        } catch {
            // Unreadable or not valid UTF-8 — leave it be and report it, so a
            // binary that slipped into the whitelist is visible in the manifest
            // rather than silently shipped unscrubbed.
            skipped += 1;
        }
    }
    return { scrubbed, skipped };
}

// ---------------------------------------------------------------------------
// Bundle contents.
// ---------------------------------------------------------------------------

function firstLine(cmd: string, args: string[]): string {
    try {
        const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 });
        if (r.status !== 0) return "unavailable";
        return (r.stdout || r.stderr || "").split("\n")[0]!.trim() || "unavailable";
    } catch {
        return "unavailable";
    }
}

/** PURE-ish: the environment block, given the values it can't look up itself. */
export function formatEnvironment(v: {
    loopName: string;
    aiballVersion: string;
    claudeVersion: string;
    tmuxVersion: string;
    nodeVersion: string;
    platform: string;
    osRelease: string;
    osType: string;
    generatedAt: string;
}): string {
    return [
        `loop            ${v.loopName}`,
        `generated       ${v.generatedAt}`,
        "",
        `aiball          ${v.aiballVersion}`,
        `claude code     ${v.claudeVersion}`,
        `tmux            ${v.tmuxVersion}`,
        `node            ${v.nodeVersion}`,
        `platform        ${v.platform} (${v.osType} ${v.osRelease})`,
        "",
    ].join("\n");
}

function formatHealth(report: Awaited<ReturnType<typeof runHealthChecks>>): string {
    const width = Math.max(...report.checks.map((c) => c.name.length));
    const glyph = { ok: "OK  ", warn: "WARN", fail: "FAIL" } as const;
    const lines = report.checks.map((c) => `${glyph[c.status]}  ${c.name.padEnd(width)}  ${c.detail}`);
    lines.push("", `${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail`);
    return lines.join("\n") + "\n";
}

/** PURE: the manifest, so the user can see what they are about to send. */
export function formatManifest(v: {
    files: string[];
    scrubbed: number;
    skipped: number;
    raw: boolean;
    paneCapturesDropped: boolean;
}): string {
    const head = [
        "This archive is a claude-loop diagnostic bundle, built to be sent to",
        "someone who does not work on your project.",
        "",
        "READ IT BEFORE YOU SEND IT. It is assembled from a whitelist — the",
        "state dir's env / env.local / claude-settings.json are never included —",
        v.raw
            ? "but --raw was used, so NOTHING was redacted."
            : `and ${v.scrubbed} file(s) went through the redaction pass.`,
        "",
    ];
    if (!v.raw) {
        head.push(
            "What the redaction does:",
            "  - known token shapes and `key: value` secrets are replaced;",
            "  - wake lines in the logs keep their timing and kind, but their",
            "    prompt payload is dropped — that payload quotes ticket titles",
            "    and comment fragments verbatim.",
            "",
            "What it does NOT do: recognise confidential prose in general. Skim",
            "the logs before sending if your project is sensitive.",
            "",
        );
    }
    if (v.paneCapturesDropped) {
        head.push(
            "Pane captures were EXCLUDED. They are verbatim screen dumps — source,",
            "file contents, anything that was on screen — and no scrub makes that",
            "safe to hand to a stranger. If the bug is about pane detection, re-run",
            "with --with-pane-captures and read them yourself first.",
            "",
        );
    }
    if (v.skipped > 0) {
        head.push(
            `${v.skipped} file(s) could not be read as text and were left as-is —`,
            "check them by hand before sending.",
            "",
        );
    }
    head.push("Contents:", "");
    return head.concat(v.files.map((f) => `  ${f}`)).join("\n") + "\n";
}

function listFiles(dir: string, base = dir): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listFiles(p, base));
        else out.push(relative(base, p));
    }
    return out.sort();
}

// ---------------------------------------------------------------------------
// Path resolution — `--out` → `claude_loop.dump_dir` → `os.tmpdir()`.
// Mirrors `aiball download`, which already does `opts.out ?? join(tmpdir(), …)`.
// ---------------------------------------------------------------------------

/** PURE: pick the archive path from the three layers. */
export function resolveOutPath(v: {
    out?: string;
    dumpDir: string;
    loopName: string;
    stamp: string;
}): string {
    if (v.out) return v.out;
    const dir = v.dumpDir.trim() || tmpdir();
    return join(dir, `claude-loop-bug-${v.loopName}-${v.stamp}.tar.gz`);
}

/** Filesystem-safe ISO stamp (same shape snapshot uses for its dirs). */
export function stampFor(nowMs: number): string {
    return new Date(nowMs).toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

// ---------------------------------------------------------------------------
// CLI entry.
// ---------------------------------------------------------------------------

export async function cmdBug(name: string, opts: BugOpts): Promise<void> {
    const sd = stateDirFor(name);
    if (!existsSync(sd)) {
        process.stderr.write(`claude-loop bug: no state dir for '${name}' (${sd})\n`);
        process.exit(1);
    }
    const nowMs = Date.now();
    const stamp = stampFor(nowMs);

    // 1. Reuse the snapshot whitelist for logs + pane captures. This also
    //    leaves a local, un-scrubbed snapshot behind, which is what you want
    //    when you need the untouched original.
    const snapDir = captureSnapshot(sd, { nowMs, note: opts.note });

    const staging = mkdtempSync(join(tmpdir(), "cl-bug-"));
    try {
        // Pane captures are excluded unless asked for — see BugOpts.
        let paneCapturesDropped = false;
        cpSync(snapDir, join(staging, "snapshot"), {
            recursive: true,
            filter: (src) => {
                if (opts.withPaneCaptures) return true;
                if (/[/\\]pane-captures([/\\]|$)/.test(src)) {
                    paneCapturesDropped = true;
                    return false;
                }
                return true;
            },
        });

        // 2. The ten verdicts, at the moment the bug is reported.
        const report = await runHealthChecks(name);
        writeFileSync(join(staging, "health.txt"), formatHealth(report));

        // 3. Environment. The proxy implementation is not repeated here —
        //    health's `proxy` line already names the one it found.
        writeFileSync(join(staging, "environment.txt"), formatEnvironment({
            loopName: name,
            aiballVersion: AIBALL_VERSION,
            claudeVersion: firstLine("claude", ["--version"]),
            tmuxVersion: firstLine("tmux", ["-V"]),
            nodeVersion: process.version,
            platform: process.platform,
            osRelease: release(),
            osType: osType(),
            generatedAt: new Date(nowMs).toISOString(),
        }));

        // 4. Scrub everything staged, unless explicitly asked not to.
        const { scrubbed, skipped } = opts.raw ? { scrubbed: 0, skipped: 0 } : scrubTree(staging);

        // 5. Manifest last, so it lists itself accurately.
        const files = listFiles(staging);
        writeFileSync(join(staging, "MANIFEST.txt"), formatManifest({
            files: files.concat("MANIFEST.txt").sort(),
            scrubbed,
            skipped,
            raw: !!opts.raw,
            paneCapturesDropped,
        }));

        // 6. One archive.
        const cfg = loadConfig();
        const outPath = resolveOutPath({
            out: opts.out,
            dumpDir: cfg.claude_loop.dump_dir,
            loopName: name,
            stamp,
        });
        const tar = spawnSync("tar", ["-czf", outPath, "-C", staging, "."], { encoding: "utf8" });
        if (tar.status !== 0) {
            process.stderr.write(`claude-loop bug: tar failed (${tar.stderr || tar.status})\n`);
            process.exit(1);
        }

        const bytes = statSync(outPath).size;
        process.stdout.write(
            `✓ bug bundle: ${outPath} (${(bytes / 1024).toFixed(1)}K)\n`
            + `  ${files.length + 1} files, ${report.summary.fail} health check(s) failing\n`
            + (opts.raw
                ? "  ⚠ --raw: nothing was redacted\n"
                : `  ${scrubbed} file(s) redacted${skipped ? `, ${skipped} unreadable as text` : ""}\n`)
            + (paneCapturesDropped ? "  pane captures excluded (--with-pane-captures to include)\n" : "")
            + "  Read MANIFEST.txt inside before attaching it to a ticket.\n",
        );
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}
