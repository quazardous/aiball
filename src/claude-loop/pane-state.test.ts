// #345 B — détecteur de pane interrompu (décoration `[idle:interrupted]`).
// node:test + tsx. Run: `npm test`.
//
// NB : la chaîne exacte de Claude Code reste à confirmer (#345 / #360) ; ces
// tests verrouillent la LOGIQUE (fenêtre de scope + insensibilité casse +
// exclusion du busy) contre le marqueur supposé « interrupted by user ».
import { test } from "node:test";
import assert from "node:assert/strict";
import { paneShowsInterrupted } from "./state.js";

const prompt = "────────────\n❯ \n────────────\n  ⏵⏵ auto mode on";

test("détecte « Interrupted by user » près du prompt", () => {
    assert.equal(paneShowsInterrupted(`● doing stuff\n  ⎿ Interrupted by user\n${prompt}`), true);
});

test("détecte « Request interrupted by user » (contient le marqueur)", () => {
    assert.equal(paneShowsInterrupted(`[Request interrupted by user]\n${prompt}`), true);
});

test("insensible à la casse", () => {
    assert.equal(paneShowsInterrupted(`INTERRUPTED BY USER\n${prompt}`), true);
});

test("pane busy (esc to interrupt) n'est PAS interrompu", () => {
    assert.equal(paneShowsInterrupted("✽ Working…\n  ⏵⏵ auto mode on · esc to interrupt"), false);
});

test("pane idle normal → false", () => {
    assert.equal(paneShowsInterrupted(prompt), false);
});

test("marqueur trop loin dans le scrollback (hors fenêtre) → false", () => {
    const old = "  ⎿ Interrupted by user";
    const filler = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    assert.equal(paneShowsInterrupted(`${old}\n${filler}\n${prompt}`), false);
});

test("fenêtre compte les lignes NON vides", () => {
    // 12 lignes non vides par défaut : le marqueur en 11e position non vide
    // (en remontant) reste vu malgré des lignes blanches intercalées.
    const blanks = "\n\n\n\n\n";
    assert.equal(paneShowsInterrupted(`  ⎿ Interrupted by user${blanks}\na\nb\nc\nd\ne\nf\ng`), true);
});
