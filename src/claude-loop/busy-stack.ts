/**
 * BusyStack — le « busy » composite comme une PILE À RÉMANENCE de preuves (#1014).
 *
 * david : « on peut s'inspirer du boot stack. on stack des preuves qu'on est
 * busy. quand plus aucune preuve ne tient on n'est plus busy ». Même modèle
 * que la BootMachine (#1009) mais oscillant (busy ↔ idle), donc exprimé en
 * helpers PURS plutôt qu'en machine XState : `busy` n'a ni seal ni emit, c'est
 * un prédicat dérivé recalculé à chaque tick pane.
 *
 *   busy = in_turn  ∨  mécanique(pane)
 *
 * Trois preuves, chacune re-signalée tant qu'elle est présente (refresh de sa
 * rémanence) :
 *   - `turn`       : le TurnMachine (#1013) est `in_turn`.
 *   - `esc`        : `esc to interrupt` visible dans le footer (règle #992).
 *   - `compacting` : `/compact` en cours (CompactingDetector).
 *
 * Une preuve « tombe » quand `now > lastSeen + remanence`. busy ⟺ AU MOINS une
 * preuve tient ; idle ⟺ toutes tombées. La rémanence donne l'hystérésis #890
 * gratuitement (la frappe pousse `esc to interrupt` hors de la fenêtre footer →
 * la preuve `esc` tient encore quelques ticks) et un `turn` renforce un signal
 * pane qui flickere — les sources « se renforcent » au lieu de se court-circuiter.
 *
 * Release : le **pane-idle** (curseur revenu à l'origine du prompt, règle #992)
 * est le release AUTORITAIRE — il vide TOUTES les preuves d'un coup, sans
 * attendre la rémanence. Donc busy tombe proprement même si le Stop hook a
 * manqué (cf. #1012). Pas de busy collé.
 */

/** Preuve « un turn est en cours » (TurnMachine in_turn). */
export const PROOF_TURN = "turn";
/** Preuve mécanique « esc to interrupt visible » (footer). */
export const PROOF_ESC = "esc";
/** Preuve mécanique « /compact en cours ». */
export const PROOF_COMPACTING = "compacting";

/** Rémanence par défaut d'une preuve : assez pour ponter un flicker pane
 *  entre deux re-signalements (~1s) sans coller le busy une fois claude
 *  réellement idle (le pane-idle release est de toute façon immédiat). */
export const DEFAULT_BUSY_REMANENCE_MS = 4_000;

export interface BusyProof {
    lastSeenMs: number;
    remanenceMs: number;
}

export type BusyProofs = Map<string, BusyProof>;

/** Upsert une preuve : (re)pose `{lastSeen, remanence}`. Immuable (renvoie une
 *  nouvelle Map) pour mirrorer la convention du boot-stack. */
export function seenProof(
    proofs: BusyProofs,
    name: string,
    nowMs: number,
    remanenceMs: number = DEFAULT_BUSY_REMANENCE_MS,
): BusyProofs {
    const next = new Map(proofs);
    next.set(name, { lastSeenMs: nowMs, remanenceMs });
    return next;
}

/** Preuves encore dans leur fenêtre de rémanence à `nowMs` (= pas tombées). */
export function liveProofs(proofs: BusyProofs, nowMs: number): string[] {
    const out: string[] = [];
    for (const [name, p] of proofs) {
        if (nowMs <= p.lastSeenMs + p.remanenceMs) out.push(name);
    }
    return out;
}

/** busy ⟺ au moins une preuve tient encore à `nowMs`. */
export function isBusy(proofs: BusyProofs, nowMs: number): boolean {
    for (const p of proofs.values()) {
        if (nowMs <= p.lastSeenMs + p.remanenceMs) return true;
    }
    return false;
}

/** Release autoritaire (pane-idle / Stop / sanity) : vide toutes les preuves
 *  d'un coup, sans attendre la rémanence. */
export function releaseAll(): BusyProofs {
    return new Map();
}
