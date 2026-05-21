// #295 first battery — pure search-query parser (#285: trigram split ≥3/<3,
// FTS5 quoting strip). node:test + tsx. Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery } from "./search.js";

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
    assert.deepEqual(parseQuery(""), { match: null, likeTokens: [], empty: true });
    assert.deepEqual(parseQuery("   "), { match: null, likeTokens: [], empty: true });
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
