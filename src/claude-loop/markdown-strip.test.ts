/**
 * #555 — couvre `stripMarkdown` (helper backend) + l'intégration `{body}`
 * token dans `buildWakePhrase` (state.ts, DEFAULT_WAKE_TEMPLATES path).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripMarkdown } from "./markdown-strip.js";
import { buildWakePhrase } from "./state.js";

test("stripMarkdown: bold + link → texte plat", () => {
    assert.equal(stripMarkdown("**hello** [world](https://x)"), "hello world");
});

test("stripMarkdown: fenced code block flatten", () => {
    assert.equal(stripMarkdown("```ts\nconst x = 1;\n```"), "const x = 1;");
});

test("stripMarkdown: headings + bullets aplatis en single line", () => {
    assert.equal(
        stripMarkdown("# Title\n\n- item 1\n- item 2"),
        "Title item 1 item 2",
    );
});

test("stripMarkdown: blockquote stripé, contenu gardé", () => {
    assert.equal(stripMarkdown("> citation"), "citation");
});

test("stripMarkdown: html entities décodées", () => {
    assert.equal(stripMarkdown("a &amp; b"), "a & b");
});

test("stripMarkdown: input vide / whitespace → \"\"", () => {
    assert.equal(stripMarkdown(""), "");
    assert.equal(stripMarkdown("   \n\t  "), "");
});

test("stripMarkdown: truncate avec ellipse sur word-boundary", () => {
    const long = "the quick brown fox jumps over the lazy dog and keeps going";
    const out = stripMarkdown(long, 20);
    assert.ok(out.length <= 20, `expected ≤20 got ${out.length}`);
    assert.ok(out.endsWith("…"), `expected trailing …, got ${JSON.stringify(out)}`);
});

test("stripMarkdown: input court < maxLen renvoyé inchangé", () => {
    assert.equal(stripMarkdown("hi", 240), "hi");
});

test("stripMarkdown: code inline kept", () => {
    assert.equal(stripMarkdown("use `npm run build`"), "use npm run build");
});

// --- buildWakePhrase integration --------------------------------------------

/** Pings yaml temporaire, no `wake_phrases` block → fallback aux defaults. */
function emptyPingsYaml(): string {
    const dir = mkdtempSync(join(tmpdir(), "aiball-wake-"));
    const path = join(dir, "pings.yaml");
    writeFileSync(path, "ping_messages: []\n");
    return path;
}

test("buildWakePhrase: comment_body inséré entre quotes via {body:+ …}", () => {
    const p = emptyPingsYaml();
    const out = buildWakePhrase(
        {
            ticket_id: 555,
            comment_hashid: "abcdef",
            intent: "request",
            comment_body: "fix the upstream chip rendering",
        },
        p,
    );
    assert.equal(
        out,
        'Handle aiball ticket #555 — new comment #abcdef. — "fix the upstream chip rendering"',
    );
});

test("buildWakePhrase: sans comment_body, le bloc {body:+ …} disparaît proprement", () => {
    const p = emptyPingsYaml();
    const out = buildWakePhrase(
        { ticket_id: 555, comment_hashid: "abcdef", intent: "request" },
        p,
    );
    assert.equal(out, "Handle aiball ticket #555 — new comment #abcdef.");
});

test("buildWakePhrase: comment_body=\"\" traité comme absent", () => {
    const p = emptyPingsYaml();
    const out = buildWakePhrase(
        {
            ticket_id: 5,
            comment_hashid: "xy",
            intent: "fyi",
            comment_body: "   ",
        },
        p,
    );
    assert.equal(out, "Heads-up on aiball ticket #5 — new comment #xy.");
});

test("buildWakePhrase: ticket_only path ignore comment_body même si fourni", () => {
    const p = emptyPingsYaml();
    const out = buildWakePhrase(
        { ticket_id: 5, intent: "panic", comment_body: "should not appear" },
        p,
    );
    // No comment_hashid → ticket_only slot, qui ne contient pas {body}.
    assert.equal(out, "URGENT: aiball ticket #5 needs you.");
});

test("buildWakePhrase: panic intent injecte aussi le body", () => {
    const p = emptyPingsYaml();
    const out = buildWakePhrase(
        {
            ticket_id: 9,
            comment_hashid: "zz",
            intent: "panic",
            comment_body: "drop everything",
        },
        p,
    );
    assert.equal(
        out,
        'URGENT: aiball ticket #9 needs you — new comment #zz. — "drop everything"',
    );
});
