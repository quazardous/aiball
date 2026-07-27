/**
 * #1580 — `paneShowsActivity`, épinglé sur des captures RÉELLES.
 *
 * Toutes les formes positives ci-dessous ont été relevées sur un loop win32 en
 * train de travailler ; la forme négative est le même pane au repos. C'est le
 * corpus qui manquait : la règle précédente reposait sur `esc to interrupt`,
 * dont aucune fixture ne montrait l'absence pendant un turn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { paneShowsActivity, paneFooterShowsBusy } from "./state.js";

// Relevées telles quelles, glyphe de spinner compris — psmux dégrade `✻` en `*`,
// donc la règle ne doit surtout PAS s'ancrer dessus.
const REELLES = [
    "* Honking… (56s · ↓ 2.3k tokens)",
    "✽ Honking… (59s · ↓ 2.3k tokens)",
    "· Honking… (58s · ↓ 2.3k tokens)",
    "✻ Honking… (1m 3s · ↓ 2.3k tokens)",
    "✢ Honking… (1m 7s · ↓ 2.3k tokens)",
    "* Smooshing… (2m 17s · ↓ 6.0k tokens)",
    "  ⎿  Running… (27s · timeout 4m)",
];

test("chaque forme d'activité relevée en vrai est détectée", () => {
    for (const l of REELLES) {
        assert.equal(paneShowsActivity(l), true, `non détectée : ${JSON.stringify(l)}`);
    }
});

test("le gérondif et le glyphe de spinner ne portent PAS la règle", () => {
    // Claude Code randomise le mot, psmux dégrade le glyphe. S'ancrer dessus,
    // c'est refaire l'erreur d'`esc to interrupt` avec un autre texte.
    assert.equal(paneShowsActivity("§ Zorglubbing… (4s · ↓ 1.1k tokens)"), true);
    assert.equal(paneShowsActivity("Honking…"), false, "le mot seul ne prouve rien");
});

test("un pane au repos ne déclenche pas", () => {
    const repos = [
        "──────────────────────────────────────────── aiball-win ──",
        "❯",
        "────────────────────────────────────────────────────────────",
        "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ].join("\n");
    assert.equal(paneShowsActivity(repos), false);
});

test("le hint esc ne suffit pas à faire une activité, et réciproquement", () => {
    // Les deux preuves sont indépendantes : c'est tout l'intérêt d'avoir ajouté
    // la seconde. Une capture où claude travaille SANS le hint est le cas qui a
    // produit le bug, et il doit être détecté par l'activité seule.
    const sansHint = "* Honking… (58s · ↓ 2.3k tokens)";
    assert.equal(paneFooterShowsBusy(sansHint), false, "le hint est absent…");
    assert.equal(paneShowsActivity(sansHint), true, "…mais l'activité, elle, est visible");

    const hintSeul = "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt";
    assert.equal(paneFooterShowsBusy(hintSeul), true);
    assert.equal(paneShowsActivity(hintSeul), false);
});

test("l'activité est cherchée sur TOUT le pane, pas dans la fenêtre du footer", () => {
    // La ligne d'activité est au-dessus de la boîte de prompt : sur une capture
    // réelle elle était en -6, hors des 5 dernières lignes non vides (dont deux
    // sont des barres d'encadrement).
    const pane = [
        "* Honking… (58s · ↓ 2.3k tokens)",
        "  ⎿  Tip: something",
        "────────────────────────────────────── aiball-win ──",
        "❯",
        "──────────────────────────────────────────────────────",
        "  ⏵⏵ auto mode on (shift+tab to cycle)",
    ].join("\n");
    assert.equal(paneShowsActivity(pane), true);
    assert.equal(paneFooterShowsBusy(pane), false, "témoin : la fenêtre footer, elle, la manque");
});
