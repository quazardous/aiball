/**
 * Frontend view of aiball's business enums.
 *
 * Single source: the daemon's `src/domain.ts`, re-exported through the
 * `@shared` alias (vite + tsconfig paths). This file used to be a hand-kept
 * MIRROR (#B.122) that drifted from the backend; sharing the module makes
 * that drift impossible. The decision-event kinds are derived from
 * `DECISION_KINDS` upstream, so the frontend inherits new verbs for free.
 */
export * from "@shared/domain";
