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
 * Quatre preuves, chacune re-signalée tant qu'elle est présente (refresh de sa
 * rémanence) :
 *   - `turn`       : le TurnMachine (#1013) est `in_turn`.
 *   - `esc`        : `esc to interrupt` visible dans le footer (règle #992).
 *   - `compacting` : `/compact` en cours (CompactingDetector).
 *   - `activity`   : la ligne spinner + chrono + tokens (#1580). La seule
 *                    mécanique qui soit CONTINUE : `esc` est un hint qui ne
 *                    s'affiche qu'une fraction du temps où il est vrai.
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
/**
 * #1580 — preuve mécanique « ligne d'activité visible » : le spinner avec son
 * chrono et son compteur de tokens.
 *
 * C'est le signal CONTINU pendant que claude travaille, là où `esc` n'est qu'un
 * hint intermittent. Mesuré sur la même trace live : ligne d'activité 30/30,
 * `esc to interrupt` 5/30. Sans elle, durcir le release ne suffisait pas — il
 * tombait de 83 % à 60 % des ticks au lieu de 0 %.
 */
export const PROOF_ACTIVITY = "activity";

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

/**
 * Les preuves MÉCANIQUES : celles lues sur le pane, par opposition à `turn`
 * qui vient du TurnMachine (donc des hooks).
 *
 * La distinction porte le release autoritaire. `turn` ne doit PAS le bloquer —
 * c'est tout l'intérêt de #1012 : un pane revenu au prompt ferme un turn resté
 * ouvert parce que le Stop hook a été manqué. Si `turn` bloquait le release, un
 * hook perdu collerait le busy indéfiniment, exactement ce que le release existe
 * pour éviter.
 */
export const MECHANICAL_PROOFS: readonly string[] = [PROOF_ESC, PROOF_COMPACTING, PROOF_ACTIVITY];

/**
 * Reste-t-il une preuve mécanique VIVANTE (dans sa rémanence) à `nowMs` ?
 *
 * #1580 — le release autoritaire testait le signal INSTANTANÉ (`esc to interrupt`
 * visible à ce tick). Or ce texte est un hint de pied de page intermittent :
 * mesuré sur graphite, présent 6 fois sur 46 captures alors que claude
 * travaillait sans discontinuer. Le release s'exécutait donc 4 ticks sur 5 en
 * plein turn, et comme il vide TOUT d'un coup sans attendre la rémanence, la
 * barre repassait grise pendant que claude travaillait.
 *
 * Interroger la rémanence au lieu de l'instant referme ça sans rien affaiblir :
 * une preuve qui a clignoté il y a une seconde tient encore, une preuve
 * réellement tombée depuis sa fenêtre ne retient plus rien. Le garde-fou
 * anti-busy-collé de #992 reste entier — il s'applique juste après la
 * rémanence, pas avant.
 */
export function mechanicalProofsLive(proofs: BusyProofs, nowMs: number): boolean {
    const live = new Set(liveProofs(proofs, nowMs));
    return MECHANICAL_PROOFS.some((p) => live.has(p));
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
