// #1560 unit tests — the pure parts of `claude-loop bug`.
// Run: `npx tsx --test src/claude-loop/cmds/bug.test.ts`.
//
// The scrub is the security-relevant piece, so it is tested from both sides:
// what it MUST redact, and what it must NOT. Over-scrubbing is a real failure
// mode here — a bundle with its git SHAs and session ids blanked out is
// useless for the diagnosis it exists to serve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scrubSecrets, resolveOutPath, stampFor, formatManifest } from "./bug.js";

// --- what MUST be redacted -------------------------------------------------

test("scrubSecrets: Anthropic API key", () => {
    const out = scrubSecrets("ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf123456789_xyz");
    assert.ok(!out.includes("sk-ant-api03"), out);
    assert.match(out, /REDACTED/);
});

test("scrubSecrets: GitHub tokens (classic + fine-grained)", () => {
    const out = scrubSecrets("ghp_abcdefghijklmnop1234 and github_pat_11ABCDEFG0123456789xyz");
    assert.ok(!out.includes("ghp_abcdefghijklmnop1234"), out);
    assert.ok(!out.includes("github_pat_11ABCDEFG0123456789xyz"), out);
});

test("scrubSecrets: bearer header", () => {
    const out = scrubSecrets('authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    assert.ok(!out.includes("eyJhbGciOiJIUzI1NiIs"), out);
    assert.match(out, /Bearer \[REDACTED\]/);
});

// The secret must be GONE; which rule got there first (the vendor-prefix one
// or the key/value one) is an implementation detail, so assert on the value
// disappearing rather than on a particular redaction label.
test("scrubSecrets: key/value secrets whatever the separator or quoting", () => {
    for (const [line, secret] of [
        ['token: "hunter2-hunter2"', "hunter2-hunter2"],
        ["api_key=abcdef123456", "abcdef123456"],
        // `upstream_auth` is the key aiball really uses for GitHub tokens —
        // the prefixed-key case this rule exists for.
        ["upstream_auth: ghs_supersecretvalue", "ghs_supersecretvalue"],
        ["password = correct-horse-battery", "correct-horse-battery"],
    ] as const) {
        const out = scrubSecrets(line);
        assert.ok(!out.includes(secret), `secret survived: ${line} → ${out}`);
        assert.match(out, /\[REDACTED/, `no redaction marker: ${line} → ${out}`);
    }
});

test("scrubSecrets: redacts every occurrence, not just the first", () => {
    const out = scrubSecrets("token=aaaaaaaaaa\ntoken=bbbbbbbbbb\n");
    assert.equal(out.match(/\[REDACTED\]/g)?.length, 2, out);
});

// --- what must SURVIVE (over-scrubbing destroys the bundle's value) --------

test("scrubSecrets: leaves git SHAs alone — they're the diagnosis", () => {
    const sha = "c06a489bd2f1e4a7c8901234567890abcdef1234";
    assert.equal(scrubSecrets(`loop source SHA ${sha} (current)`), `loop source SHA ${sha} (current)`);
});

test("scrubSecrets: leaves session UUIDs alone", () => {
    const line = "session_id: 00000000-0000-4000-8000-000000000000";
    assert.equal(scrubSecrets(line), line);
});

test("scrubSecrets: leaves ordinary log prose alone", () => {
    const line = '{"ts":"2026-07-26T10:00:00Z","msg":"wake:diag kind=event ticket=#1557"}';
    assert.equal(scrubSecrets(line), line);
});

// --- output path: --out → dump_dir → $TMPDIR -------------------------------

test("resolveOutPath: --out wins over everything", () => {
    const p = resolveOutPath({ out: "/somewhere/mine.tar.gz", dumpDir: "/configured", loopName: "l", stamp: "s" });
    assert.equal(p, "/somewhere/mine.tar.gz");
});

test("resolveOutPath: dump_dir when no --out", () => {
    const p = resolveOutPath({ dumpDir: "/configured", loopName: "cl-x", stamp: "2026-01-01T00-00-00" });
    assert.equal(p, "/configured/claude-loop-bug-cl-x-2026-01-01T00-00-00.tar.gz");
});

test("resolveOutPath: falls back to $TMPDIR when dump_dir is empty or blank", () => {
    for (const dumpDir of ["", "   "]) {
        const p = resolveOutPath({ dumpDir, loopName: "cl-x", stamp: "s" });
        assert.equal(p, join(tmpdir(), "claude-loop-bug-cl-x-s.tar.gz"));
    }
});

test("stampFor: no colons or dots — safe as a filename on every platform", () => {
    const s = stampFor(Date.parse("2026-07-26T10:41:21.405Z"));
    assert.ok(!/[:.]/.test(s), s);
    assert.equal(s, "2026-07-26T10-41-21-405");
});

// --- manifest --------------------------------------------------------------

test("formatManifest: --raw says loudly that nothing was redacted", () => {
    const m = formatManifest({ files: ["health.txt"], scrubbed: 0, skipped: 0, raw: true });
    assert.match(m, /NOTHING was redacted/);
});

test("formatManifest: flags files it couldn't read as text", () => {
    const m = formatManifest({ files: ["a"], scrubbed: 3, skipped: 2, raw: false });
    assert.match(m, /2 file\(s\) could not be read as text/);
});

test("formatManifest: always warns that prose isn't recognised", () => {
    const m = formatManifest({ files: ["a"], scrubbed: 1, skipped: 0, raw: false });
    assert.match(m, /loop\.log contains ticket titles/);
});
