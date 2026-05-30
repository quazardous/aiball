// #345 B — détecteur de pane interrompu (décoration `[idle:interrupted]`).
// node:test + tsx. Run: `npm test`.
//
// NB : la chaîne exacte de Claude Code reste à confirmer (#345 / #360) ; ces
// tests verrouillent la LOGIQUE (fenêtre de scope + insensibilité casse +
// exclusion du busy) contre le marqueur supposé « interrupted by user ».
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPaneSpecial, paneShowsInterrupted, snapshotPane } from "./state.js";

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

// #577 — classifyPaneSpecial doit être footer-scoped (#B.185 fix appliqué).
// Sans ça, un `✶ Compacting conversation… (42s)` qui traîne dans le scrollback
// après `/compact` terminé reste matché et bloque tous les wakes pour toujours.

// #650 — la classification exige MAINTENANT à la fois le texte
// "Compacting conversation" ET la co-présence de `esc to interrupt` dans
// le footer. Le `\d+\s?%` requirement précédent (#629 yt3h5y) cassait
// silencieusement la détection : l'UI Claude Code actuelle affiche
// `(12s · ↓ tokens · esc to interrupt)` SANS pourcentage. Le `esc to
// interrupt` est le signal canonique de turn live ; il disparaît dès
// que le prompt revient, donc le stale est filtré pareil.

test("classifyPaneSpecial: live compacting avec NN% → 'compacting'", () => {
    const live = "● earlier output\n✶ Compacting conversation… 42%\n  ⏵⏵ auto mode on · esc to interrupt";
    assert.equal(classifyPaneSpecial(live), "compacting");
});

test("classifyPaneSpecial: 'Compacting conversation' avec (12s) + esc to interrupt → 'compacting'", () => {
    // #650 — l'UI actuelle de Claude Code montre le temps elapsed `(12s)`
    // sans pourcentage ; le `esc to interrupt` reste le signal live.
    const live = "● earlier output\n✶ Compacting conversation… (12s)\n  esc to interrupt";
    assert.equal(classifyPaneSpecial(live), "compacting");
});

test("classifyPaneSpecial: 'Compacting' et 'esc to interrupt' sur lignes différentes → 'compacting'", () => {
    // Pas forcément sur la même ligne — n'importe où dans le footer suffit.
    const multiline = "✶ Compacting conversation…\n  progress\n  esc to interrupt";
    assert.equal(classifyPaneSpecial(multiline), "compacting");
});

test("classifyPaneSpecial: stale 'Compacting' dans le scrollback (prompt revenu) → null", () => {
    // Reproduit le scénario #577 : /compact terminé, le prompt est de retour,
    // mais la ligne `✶ Compacting conversation… (42s)` reste 20+ lignes plus
    // haut dans le scrollback rendu par tmux capture-pane. Le `prompt`
    // helper n'a pas `esc to interrupt` → co-présence échoue → null.
    const stale = "✶ Compacting conversation… (42s)";
    const filler = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    assert.equal(classifyPaneSpecial(`${stale}\n${filler}\n${prompt}`), null);
});

test("classifyPaneSpecial: 'Compacting' SANS 'esc to interrupt' (fin de turn) → null", () => {
    // Cas où Compacting est dans le footer mais le prompt est déjà revenu
    // sur la dernière ligne (esc to interrupt parti). Filtré par le live
    // signal manquant.
    const finished = "✶ Compacting conversation… (42s)\n────\n❯ \n  ⏵⏵ auto mode on";
    assert.equal(classifyPaneSpecial(finished), null);
});

test("classifyPaneSpecial: 'esc to interrupt' sans 'Compacting' (turn normal) → null", () => {
    // Un turn normal a esc to interrupt mais pas de Compacting → pas matché.
    const normalTurn = "● doing work\n● more work\n  ⏵⏵ auto mode on · esc to interrupt";
    assert.equal(classifyPaneSpecial(normalTurn), null);
});

test("classifyPaneSpecial: pane idle normal → null", () => {
    assert.equal(classifyPaneSpecial(prompt), null);
});

test("snapshotPane: stale 'Compacting' scrollback + prompt → busy:false special:null", () => {
    // Cas exact du timer.log du #577 : `pane=busy:false special=compacting`
    // figé sur true à cause du scrollback. Après fix : special:null.
    const stale = "✶ Compacting conversation… (42s)";
    const filler = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const snap = snapshotPane(`${stale}\n${filler}\n${prompt}`);
    assert.equal(snap.busy, false);
    assert.equal(snap.special, null);
});

test("snapshotPane: live compacting (esc to interrupt + Compacting NN% au footer) → busy:true special:'compacting'", () => {
    const live = "● earlier\n✶ Compacting conversation… 42%\n  ⏵⏵ auto mode on · esc to interrupt";
    const snap = snapshotPane(live);
    assert.equal(snap.busy, true);
    assert.equal(snap.special, "compacting");
});

test("snapshotPane: live compacting au format (12s) actuel → busy:true special:'compacting'", () => {
    // #650 — l'UI Claude Code récente n'affiche plus le `NN%` mais
    // `(12s · ↓ tokens · esc to interrupt)`. Le fix doit le détecter.
    const live = "● earlier\n✶ Compacting conversation… (12s · ↓ 1.2k tokens)\n  ⏵⏵ auto mode on · esc to interrupt";
    const snap = snapshotPane(live);
    assert.equal(snap.busy, true);
    assert.equal(snap.special, "compacting");
});
