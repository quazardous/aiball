/**
 * #953 — PromptZoneWatcher : détection STRUCTURELLE de la box d'input
 * Claude Code (deux lignes `─` qui encadrent un `❯`). Plus robuste que
 * le `IdlePromptWatcher` text-based (regex `ctrl+t to show task`) qui
 * dépend du mode + de la version Claude Code.
 *
 * Émet `begin`/`end` standard sur les transitions ; le consumer dans
 * timer.ts pont `setIpcPromptZoneVisible` pour que le BarRenderer
 * peigne le glyphe `❯` dans le marker segment (david `f72kpq`).
 *
 * Géométrie disponible via `snapshot().zone` pour les futurs consumers
 * qui voudraient connaître la ligne du chevron / du top / du bottom.
 */
import { BoolWatcher } from "./bool-watcher.js";
import type { PaneScanCtx } from "./types.js";

export interface PromptZone {
    top: number;
    chevron: number;
    bottom: number;
}

/** Scan bottom-up : cherche une ligne faite UNIQUEMENT de `─` (≥20), puis
 *  un `❯` 1-5 lignes au-dessus, puis une autre ligne de cadre 1-3 lignes
 *  au-dessus du chevron. Retourne les indices ou `null`.
 *
 *  Seuil 20 `─` choisi pour éviter les false-positives sur des
 *  séparateurs courts dans la conversation (Claude Code écrit ses
 *  boxes en largeur terminal, donc largement >20).
 *
 *  #1588 — la règle exige un plein-match `/^─{20,}$/` sur les DEUX barres.
 *  Or Claude Code écrit un LABEL dans la barre du haut (le nom de session,
 *  que la loop lui passe en `-n <agent>`) : la barre du bas passe, celle du
 *  haut jamais, et **la box n'est pas détectée du tout** — mesuré 0/30 sur
 *  Linux et 0/46 sur Windows.
 *
 *  ⚠️ NE PAS « RÉPARER » CECI SEUL. C'est un bug connu, laissé en place
 *  DÉLIBÉRÉMENT jusqu'à ce que #1580 ait durci le release du busy.
 *
 *  Le correctif (accepter une barre décorée via `isFrameRule`, qui matche
 *  sur la série de tête) a été écrit, déployé, et retiré le 2026-07-27 :
 *  mesuré sur la machine de `aiball-win`, il fait passer `findPromptZone`
 *  de 0/46 à 32/32 — et donc le release autoritaire de `kernel.ts:961`
 *  de 0/46 à **26/32, soit 81 % des ticks**, parce que ce release n'est
 *  gardé que par la présence de `esc to interrupt` au tick, un signal
 *  mesuré entre 6/46 et 59/59 sur une même machine. `kernel.ts:970` ferme
 *  le turn au même instant, donc la preuve `turn` ne rattrape pas.
 *
 *  Ce chemin n'a jamais tourné en production : le réparer l'allume d'un
 *  coup. L'ordre est donc : durcir le release (exiger l'absence de TOUTE
 *  preuve mécanique, pas du seul hint), PUIS remettre `isFrameRule` ici.
 *  Le prédicat est prêt et testé dans `pane-decor.ts`. */
export function findPromptZone(paneText: string): PromptZone | null {
    const lines = paneText.split("\n");
    for (let i = lines.length - 1; i >= 2; i--) {
        if (!/^─{20,}$/.test(lines[i].trim())) continue;
        for (let j = i - 1; j >= Math.max(1, i - 6); j--) {
            const inner = lines[j];
            if (!/^\s*❯/.test(inner)) continue;
            for (let k = j - 1; k >= Math.max(0, j - 4); k--) {
                if (/^─{20,}$/.test(lines[k].trim())) {
                    return { top: k, chevron: j, bottom: i };
                }
            }
        }
    }
    return null;
}

export class PromptZoneWatcher extends BoolWatcher {
    readonly name = "prompt_zone";
    private lastZone: PromptZone | null = null;

    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        const zone = findPromptZone(paneText);
        this.lastZone = zone;
        return zone !== null;
    }

    /** Géométrie de la dernière box détectée (pour consumers qui veulent
     *  scroller, mesurer le content, etc.). Mis à jour à chaque
     *  `observe()`. `null` quand pas de box visible. */
    zone(): PromptZone | null {
        return this.lastZone;
    }
}

/**
 * #992/#993 david `<chat>` : "savoir si le prompt est vide ou pas". True when
 * the input box is visible AND the user hasn't typed anything.
 *
 * CURSOR-COLUMN rule (authoritative) — david : "si le curseur n'est pas à
 * l'origine de l'input, c'est qu'on tape, c'est tout". The prompt is "empty"
 * iff the cursor sits at (or before) the input-start column on the chevron row.
 * This is CONTENT-INDEPENDENT, so it's immune to Claude's greyed
 * ghost-suggestions : a suggestion (applied with Tab) leaves the cursor parked
 * at the input start, so it reads as empty even though the line shows text.
 *
 * Fallback (no cursor — replay/tests) : whole-line text after the prefix. The
 * empty Claude prompt renders the chevron as just `❯`+U+00A0 with no padding,
 * so "no non-whitespace after the chevron" means empty (can't tell a ghost
 * apart without the cursor — accepted in the cursor-less fallback).
 */
export function promptInputEmpty(
    paneText: string,
    ctx?: { cursorX?: number; cursorY?: number },
    zone: PromptZone | null = findPromptZone(paneText),
): boolean {
    if (!zone) return false;
    const chevronLine = paneText.split("\n")[zone.chevron] ?? "";
    const prefix = chevronLine.match(/^\s*❯[\s ]?/u)?.[0] ?? "";
    if (ctx && typeof ctx.cursorX === "number" && ctx.cursorY === zone.chevron) {
        // cursor at/before the input start = nothing actively typed.
        return ctx.cursorX <= prefix.length;
    }
    const after = chevronLine.slice(prefix.length).replace(/[\s ]/gu, "");
    return after.length === 0;
}

/** #993 — input box visible AND non-empty (real unsent text at the prompt,
 *  ghost-suggestions excluded via the cursor). Drives the coloured `❯` glyph
 *  in the bar (david `<chat>` : "si le prompt n'est pas vide on peut afficher
 *  le symbole prompt en couleur"). */
export class PromptInputWatcher extends BoolWatcher {
    readonly name = "prompt_input";
    protected classify(paneText: string, ctx: PaneScanCtx): boolean {
        const zone = findPromptZone(paneText);
        if (!zone) return false;
        return !promptInputEmpty(paneText, ctx, zone);
    }
}
