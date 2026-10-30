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
/**
 * #4121 — preuve mécanique « un prompt attend dans la file de Claude Code »
 * (`Press up to edit queued messages` dans la zone de saisie). La file ne se
 * vide que dans un tour : tant qu'elle est là, Claude n'a pas fini, même quand
 * rien d'autre ne se voit (une compaction).
 */
export const PROOF_QUEUED = "queued";

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
export const MECHANICAL_PROOFS: readonly string[] = [PROOF_ESC, PROOF_COMPACTING, PROOF_ACTIVITY, PROOF_QUEUED];

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

/**
 * #4437 — the proofs that came on and went off between two reads of the live
 * set, for the loop's log: which proof holds busy is otherwise invisible, so
 * "esc no longer shows" or "a turn ran with no proof on screen" can't be read
 * back from `loop.log`. Null when nothing changed.
 */
export function proofChanges(before: readonly string[], after: readonly string[]): { on: string[]; off: string[] } | null {
    const on = after.filter((p) => !before.includes(p));
    const off = before.filter((p) => !after.includes(p));
    return on.length || off.length ? { on, off } : null;
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

/**
 * #4014 — how long a turn may go without a mechanical proof before the
 * pane alone may close it (a lost Stop hook, a turn too short to draw).
 */
export const PANE_IDLE_TURN_FLOOR_MS = 5_000;

/**
 * Does the pane read idle — the authoritative release of every proof, and
 * the pane-side turn-end (#1012)?
 *
 * #4014 — right after a submit the input box is back, empty, cursor at its
 * origin, and Claude has not drawn its spinner yet: no mechanical proof, so
 * the pane read idle within milliseconds of every submit. The turn ended
 * there, the tempo ran through the whole turn, and a wake was typed into a
 * working Claude. Within a turn, the pane may only speak once a mechanical
 * proof has shown in that turn (it then went away: Claude is done), or once
 * the turn is older than the floor without any (the Stop hook was lost, or
 * the turn ended before a frame showed it).
 */
export function paneReadsIdle(o: {
    idlePromptVisible: boolean;
    mechanicalLive: boolean;
    inTurn: boolean;
    /** A mechanical proof showed since the turn started. */
    turnShowedWork: boolean;
    sinceTurnStartMs: number;
    floorMs?: number;
}): boolean {
    if (!o.idlePromptVisible || o.mechanicalLive) return false;
    if (!o.inTurn) return true;
    return o.turnShowedWork || o.sinceTurnStartMs >= (o.floorMs ?? PANE_IDLE_TURN_FLOOR_MS);
}
