/**
 * #1832 — the project standing instruction, at the layer where a mistake is
 * silent: the preference encode/read pair.
 *
 * What matters is that CLEARING really clears. The operator types an
 * instruction before stepping away and wipes the field on return; if an empty
 * string were stored and read back as a value, every wake would carry a blank
 * prefix forever and nothing would look wrong.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PREF_DEFS_FOR_TEST } from "./preferences.js";

const def = PREF_DEFS_FOR_TEST.standingPrompt;
const row = (v: string | null) => ({ standingPrompt: v } as never);

test("a real instruction round-trips", () => {
    const stored = def.encode("priorité au debug léger");
    assert.equal(stored, "priorité au debug léger");
    assert.equal(def.read(row(stored)), "priorité au debug léger");
});

test("clearing stores NULL, not an empty string", () => {
    assert.equal(def.encode(null), null);
    assert.equal(def.encode(undefined), null);
    assert.equal(def.encode(""), null);
    assert.equal(def.encode("   "), null);
});

test("whitespace-only in the column reads as unset, not as a blank prefix", () => {
    // Defence in depth: even if a NULL slipped past encode, the read must not
    // hand the wake builder a value that renders an empty lead.
    assert.equal(def.read(row("   ")), undefined);
    assert.equal(def.read(row("")), undefined);
    assert.equal(def.read(row(null)), undefined);
});

test("surrounding whitespace is trimmed on the way in", () => {
    assert.equal(def.encode("  debug léger  "), "debug léger");
});
