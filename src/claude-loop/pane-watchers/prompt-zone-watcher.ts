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

/** Scan bottom-up : cherche une ligne pleine de `─` (≥20), puis un
 *  `❯` 1-5 lignes au-dessus, puis une autre ligne pleine de `─` 1-3
 *  lignes au-dessus du chevron. Retourne les indices ou `null`.
 *
 *  Seuil 20 `─` choisi pour éviter les false-positives sur des
 *  séparateurs courts dans la conversation (Claude Code écrit ses
 *  boxes en largeur terminal, donc largement >20). */
export function findPromptZone(paneText: string): PromptZone | null {
    const lines = paneText.split("\n");
    for (let i = lines.length - 1; i >= 2; i--) {
        const bottom = lines[i].trim();
        if (!/^─{20,}$/.test(bottom)) continue;
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
