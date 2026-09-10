// #295 first battery — pure search-query parser (#285: trigram split ≥3/<3,
// FTS5 quoting strip). node:test + tsx. Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, wholeWordScore } from "./search.js";

test("parseQuery: long (≥3-char) tokens become quoted MATCH literals", () => {
    const r = parseQuery("hello world");
    assert.equal(r.match, '"hello" "world"');
    assert.deepEqual(r.likeTokens, []);
    assert.equal(r.empty, false);
});

test("parseQuery: short (<3-char) tokens go to likeTokens, no MATCH", () => {
    const r = parseQuery("ab");
    assert.equal(r.match, null);
    assert.deepEqual(r.likeTokens, ["ab"]);
    assert.equal(r.empty, false);
});

test("parseQuery: mixed long + short", () => {
    const r = parseQuery("ab cde");
    assert.equal(r.match, '"cde"');
    assert.deepEqual(r.likeTokens, ["ab"]);
});

test("parseQuery: empty / whitespace-only → empty", () => {
    // #2193 — `wordTokens` joined the shape when the whole-word re-rank
    // landed; this deep-equal is what caught the addition, which is the point
    // of pinning a returned object rather than a field at a time.
    assert.deepEqual(parseQuery(""), { match: null, likeTokens: [], wordTokens: [], empty: true });
    assert.deepEqual(parseQuery("   "), { match: null, likeTokens: [], wordTokens: [], empty: true });
});

test("parseQuery: strips FTS5 quoting / prefix chars", () => {
    // "foo"→foo, (bar)→bar, baz*→baz — all ≥3 chars
    const r = parseQuery('"foo" (bar) baz*');
    assert.equal(r.match, '"foo" "bar" "baz"');
});

test("parseQuery: char-stripping can shrink a token below 3 → LIKE", () => {
    const r = parseQuery("a()b"); // → "ab" (2 chars)
    assert.equal(r.match, null);
    assert.deepEqual(r.likeTokens, ["ab"]);
});

test("parseQuery: trims surrounding whitespace", () => {
    assert.equal(parseQuery("  foo  ").match, '"foo"');
});

// #2193 — the whole-word re-rank.
//
// The trigram tokenizer matches SUBSTRINGS, which is what gives `broad` →
// `broadcast` and is worth keeping. What it costs is precision on short
// tokens: measured on the live corpus, `lock` returned 132 tickets of which
// 86 matched only through `block` / `blocked` — a ticket STATE here, not a
// lock. So the substring stays the recall rule and this becomes the order
// rule: nothing is filtered out, the rows holding the real word sort first.
test("wholeWordScore: a whole word scores, the same letters inside another word do not", () => {
    assert.equal(wholeWordScore(["lock"], "the lock is held", null), 1);
    // The exact corpus collision this exists for.
    assert.equal(wholeWordScore(["lock"], "ticket is blocked by #12", null), 0);
    assert.equal(wholeWordScore(["lock"], "unlock the door", null), 0);
});

test("wholeWordScore folds accents, or it would demote a correct hit", () => {
    // FTS5 finds `modération` when you type `moderation`. A strict word test
    // would then score that hit zero and push it BEHIND the substring noise —
    // the exact opposite of the point.
    assert.equal(wholeWordScore(["moderation"], "la modération humaine", null), 1);
    assert.equal(wholeWordScore(["réveil"], "le REVEIL de la loop", null), 1);
});

test("wholeWordScore counts each query token, and reads every part", () => {
    assert.equal(wholeWordScore(["hook", "wake"], "hook fires", "then wake"), 2);
    assert.equal(wholeWordScore(["hook", "wake"], "hook fires", "nothing else"), 1);
    assert.equal(wholeWordScore([], "anything", null), 0);
});

test("the boundary is Unicode-aware — an accented letter is not a word break", () => {
    // JS `\b` is ASCII-only: `\bréveil\b` asserts a boundary between `r` and
    // `é`, so a naive implementation matches `préréveil` and misses nothing it
    // should. This pins the behaviour that made me not use `\b`.
    assert.equal(wholeWordScore(["reveil"], "un préréveil bizarre", null), 0);
    assert.equal(wholeWordScore(["reveil"], "un réveil bizarre", null), 1);
});

test("a regex metacharacter in the query does not throw", () => {
    // Tokens reach here as the user typed them; `parseQuery` strips FTS5
    // syntax but not regex syntax.
    // `c++` DOES match `c++` — the escape makes the literal work and the
    // lookarounds see spaces on both sides. My first assertion said 0 and was
    // simply wrong about my own regex.
    assert.equal(wholeWordScore(["c++"], "we use c++ here", null), 1);
    assert.equal(wholeWordScore(["c++"], "we use cpp here", null), 0);
    assert.doesNotThrow(() => wholeWordScore(["a.b", "[x]", "(y)"], "a.b [x] (y)", null));
});
