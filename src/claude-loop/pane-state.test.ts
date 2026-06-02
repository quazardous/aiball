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

// #650 david `tjab9e` — la classification exige texte "Compacting
// conversation" + au moins un signal "live" parmi : progress bar
// Unicode (▰/▱), percentage (NN%), ou `esc to interrupt`. La capture
// réelle du UI Claude montre progress + % (parfois sans esc-to-
// interrupt visible). Le stale "✶ Compacting conversation… (42s)" sans
// progress ni % est filtré. Premier essai (esc-to-interrupt only) cassé
// car les nouveaux formats compact n'ont PAS esc-to-interrupt au footer.

test("classifyPaneSpecial: live compacting avec NN% → 'compacting'", () => {
    const live = "● earlier output\n✶ Compacting conversation… 42%\n  ⏵⏵ auto mode on · esc to interrupt";
    assert.equal(classifyPaneSpecial(live), "compacting");
});

test("classifyPaneSpecial: format réel David (progress bar + %, sans esc to interrupt) → 'compacting'", () => {
    // #650 david `tjab9e` capture : progress bar Unicode + percent au
    // footer, pas de esc-to-interrupt. Doit matcher.
    const real = "✽ Compacting conversation… (1m 12s)\n  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 55%";
    assert.equal(classifyPaneSpecial(real), "compacting");
});

test("classifyPaneSpecial: format minimal (texte + progress bar seule, pas de %) → 'compacting'", () => {
    // Variant intermédiaire : le progress bar Unicode suffit comme live
    // signal même si le pourcentage n'est pas encore rendu (frame initial).
    const initial = "Compacting conversation… \n  ▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱";
    assert.equal(classifyPaneSpecial(initial), "compacting");
});

test("classifyPaneSpecial: 'Compacting' + esc to interrupt seul (sans progress/%) → null", () => {
    // #678 david `y3s6a8` : `esc to interrupt` retiré du live signal car
    // c'est le marqueur busy-générique (présent au footer de TOUTE turn
    // normale via `⏵⏵ auto mode on … · esc to interrupt`). Pairé à un
    // `Compacting` traînant dans le scrollback, ça mis-classifierait chaque
    // turn normale post-/compact. Seul progress bar (`▰▱`) ou `NN%`
    // discriminent le live compact. Ce format legacy isolé (sans progress
    // ni %) n'est plus détecté — acceptable, pas observé dans le UI claude
    // actuel.
    const legacyIsolated = "● earlier output\n✶ Compacting conversation… (12s)\n  esc to interrupt";
    assert.equal(classifyPaneSpecial(legacyIsolated), null);
});

test("classifyPaneSpecial: format réel #678 — Compacting hors footer-5, progress bar dedans → 'compacting'", () => {
    // #678 david `y3s6a8` : capture réelle d'un /compact actif où la boîte
    // de séparateurs autour du prompt + la ligne auto-mode aval poussent le
    // texte "Compacting conversation" au-delà du footer-5 lignes. Le live
    // signal (progress bar `▰▱` + percentage `28%`) reste juste au footer.
    // Le détecteur DOIT trouver le texte sur le pane complet et le live
    // signal au footer.
    const realCapture = [
        "● Nettoyé (hack retiré du repo + de la box).",
        "",
        "  Petit point à vérifier toi-même : ...",
        "",
        "✻ Crunched for 9s",
        "",
        "❯ /compact",
        "",
        "✢ Compacting conversation… (29s)",
        "  ▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 28%",
        "",
        "─".repeat(80),
        "❯ ",
        "─".repeat(80),
        "",
        "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt",
    ].join("\n");
    assert.equal(classifyPaneSpecial(realCapture), "compacting");
});

test("classifyPaneSpecial: % et 'Compacting' sur lignes différentes → 'compacting'", () => {
    const multiline = "✶ Compacting conversation…\n  progress: 42%\n  esc to interrupt";
    assert.equal(classifyPaneSpecial(multiline), "compacting");
});

test("classifyPaneSpecial: stale 'Compacting' dans le scrollback (prompt revenu) → null", () => {
    // Reproduit le scénario #577 : /compact terminé, le prompt est de retour.
    // Le `prompt` helper n'a ni %, ni progress bar Unicode, ni esc-to-
    // interrupt → tous les live signals échouent → null.
    const stale = "✶ Compacting conversation… (42s)";
    const filler = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    assert.equal(classifyPaneSpecial(`${stale}\n${filler}\n${prompt}`), null);
});

test("classifyPaneSpecial: stale 'Compacting' avec (42s) seul dans footer → null", () => {
    // Même cas mais le stale lui-même est dans le footer (juste lui +
    // prompt). Aucun live signal → null.
    const stale = "✶ Compacting conversation… (42s)\n────\n❯ \n  ⏵⏵ auto mode on";
    assert.equal(classifyPaneSpecial(stale), null);
});

test("classifyPaneSpecial: % sans 'Compacting' (progress bar quelconque) → null", () => {
    const other = "Downloading model… 42%\n  esc to interrupt";
    assert.equal(classifyPaneSpecial(other), null);
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

test("snapshotPane: format (12s) sans progress bar — busy:true mais special:null (#678 trade-off)", () => {
    // #650 documenta une variante "(12s · ↓ tokens · esc to interrupt)" sans
    // progress bar. La capture #678 david `y3s6a8` montre le format ACTUEL
    // (avec `▰▱` + `%`). Le fix #678 retire `esc to interrupt` du live signal
    // pour ne pas mis-classifier les turns normales post-/compact (stale
    // Compacting en scrollback + esc-to-interrupt du footer auto-mode =
    // faux positif persistant). La variante sans-progress n'est donc plus
    // détectée — busy reste true (esc-to-interrupt fait toujours
    // paneFooterShowsBusy), seul le tag compacting tombe. Si cette variante
    // refait surface en pratique, on rajoutera un discriminant strict
    // (e.g. esc-to-interrupt ON THE SAME LINE que Compacting).
    const live = "● earlier\n✶ Compacting conversation… (12s · ↓ 1.2k tokens)\n  ⏵⏵ auto mode on · esc to interrupt";
    const snap = snapshotPane(live);
    assert.equal(snap.busy, true);
    assert.equal(snap.special, null);
});
