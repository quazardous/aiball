/**
 * #2193 — the bilingual dictionary.
 *
 * These run against the SHIPPED `config/search-synonyms.yaml`, on purpose: the
 * file is versioned and is part of the behaviour, so a pair removed by mistake
 * should break a test rather than quietly narrow everyone's search.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandToken, foldTerm } from "./search-synonyms.js";

test("a token in a group expands to the group, caller's spelling first", () => {
    const r = expandToken("réveil");
    assert.equal(r[0], "réveil", "the word as typed leads — the re-rank rewards it");
    assert.ok(r.includes("wake"), `expected wake in ${JSON.stringify(r)}`);
});

test("expansion is symmetric — the English side reaches the French one", () => {
    // Measured before this existed: `réveil` and `wake` shared 7 % of their
    // results while naming the same thing.
    assert.ok(expandToken("wake").includes("réveil"));
    assert.ok(expandToken("lock").includes("verrou"));
});

test("lookup folds accents, so an unaccented query still finds its group", () => {
    // Typing `reveil` is the common case on a keyboard in a hurry.
    assert.ok(expandToken("reveil").includes("wake"));
    assert.equal(foldTerm("MODÉRATION"), "moderation");
});

test("a token in no group comes back alone — the common case costs nothing", () => {
    assert.deepEqual(expandToken("systemd"), ["systemd"]);
    assert.deepEqual(expandToken("xyzzy"), ["xyzzy"]);
});

test("the pairs rejected on measurement stay rejected", () => {
    // `file` appears 1277 times in the corpus, 237 of them meaning a FILE
    // against 36 meaning a queue; `porte` is overwhelmingly the verb. Pairing
    // either would make the search quietly answer a different question. This
    // pins the decision so nobody re-adds them on intuition.
    assert.deepEqual(expandToken("file"), ["file"]);
    assert.deepEqual(expandToken("porte"), ["porte"]);
    assert.deepEqual(expandToken("modèle"), ["modèle"]);
});
