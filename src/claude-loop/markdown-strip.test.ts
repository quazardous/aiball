/**
 * #555 — couvre l'intégration `{body}` token dans `buildWakePhrase`
 * (state.ts, DEFAULT_WAKE_TEMPLATES path).
 *
 * #750 Slice 2 — les cas pure `stripMarkdown(str)` sont migrés vers
 * `tests/integration/scenarios/markdown-strip.yaml` (yaml runner via
 * `expect_value`). Les tests ici restent en TS parce qu'ils nécessitent
 * un fichier `pings.yaml` temporaire (mkdtempSync) passé en arg —
 * non-exprimable dans le `args` positionnel du runner yaml.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWakePhrase } from "./state.js";

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
    // #635 david `yqv38b` — guillemets retirés du default template, le body
    // s'insère bare après le ` — `. Le commit lisible reste explicite via
    // le séparateur unicode.
    assert.equal(
        out,
        "Handle aiball ticket #555 — new comment #abcdef. — fix the upstream chip rendering",
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
    // #635 david `yqv38b` — guillemets retirés du default template (cf. ci-dessus).
    assert.equal(
        out,
        "URGENT: aiball ticket #9 needs you — new comment #zz. — drop everything",
    );
});
