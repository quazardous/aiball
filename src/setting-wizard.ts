/**
 * #4682 — a folder setting that breaks things when changed bare carries a
 * wizard: aiball describes it (a preview: the questions to answer before
 * anything runs, the steps it will take, the fallback), runs it, and says each
 * step's state as it goes; a client shows the questions, then follows the run,
 * without knowing the setting. Questions are all asked at the start: nothing
 * waits on a client in the middle of a run.
 *
 * This module is the engine, free of the bus and of the machine: a setting's
 * wizard is a `WizardPlan` (its preview and a function per step), and
 * `runWizard` takes a run from its first step to its end.
 */

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type RunStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";

/** A question answered at the start: `confirm` takes true, `choose` the key of one of its options. */
export interface WizardQuestion {
    id: string;
    kind: "confirm" | "choose";
    label: string;
    /** The facts the label names, for a client that says the question in its own words. */
    facts?: Record<string, unknown>;
    options?: Array<{ key: string; label: string }>;
    default?: string;
}

export interface WizardStepView {
    id: string;
    label: string;
    /** Once this step has started, the change cannot be cancelled nor undone by the fallback. */
    point_of_no_return?: true;
}

export interface WizardLoop {
    name: string;
    agent: string | null;
    busy: boolean;
}

/** What `project.setting_wizard_preview` answers: nothing has run. */
export interface WizardPreview {
    key: string;
    value: unknown;
    title: string;
    loops: WizardLoop[];
    questions: WizardQuestion[];
    steps: WizardStepView[];
    fallback: string;
    /** What `fallback` says, as a code with its facts. */
    fallback_code: string;
    fallback_facts?: Record<string, unknown>;
}

export interface StepState extends WizardStepView {
    status: StepStatus;
    /** A sentence for the human, in English: what the step does or did. */
    said: string | null;
    /** What `said` says, as a stable code; its facts are in `details`. */
    code: string | null;
    /** What it saw or did: pids, conversations moved, loops started. */
    details?: Record<string, unknown>;
}

/** A run, whole, as `wizard.<run>.state` carries it. */
export interface WizardRun {
    run: string;
    cwd: string;
    key: string;
    value: unknown;
    status: RunStatus;
    started_at: string;
    ended_at: string | null;
    steps: StepState[];
    /** Set at the end when the fallback had to run, or could have. */
    fallback: FallbackResult | null;
    /** At the end, the folder's settings as `project.settings` gives them. */
    settings: unknown;
}

/** What the fallback did: `said` in English, `code` and `details` for a client that says it its own way. */
export interface FallbackResult {
    ran: boolean;
    said: string;
    code: string;
    details?: Record<string, unknown>;
}

/** What a step says: an English sentence, its code, and the facts it names. */
export interface Said {
    said: string;
    code: string;
    details?: Record<string, unknown>;
}

/** A step that cannot go on: the run fails here, `said` says why. */
export class StepFailed extends Error {
    constructor(readonly what: Said) {
        super(what.said);
    }
}

/** Thrown by `StepCtx.waitUntil` when the run was cancelled meanwhile. */
export class StepCancelled extends Error {
    constructor() {
        super("cancelled");
    }
}

export interface StepCtx {
    answers: Record<string, unknown>;
    /** Say what the step does now; the run is published again. */
    say(what: Said): void;
    /**
     * Poll `ready` until it holds, saying `waiting()` meanwhile; fails with
     * `timeout()` past `ms`, and stops at once on a cancellation.
     */
    waitUntil(ready: () => boolean, ms: number, waiting: () => Said, timeout: () => Said): Promise<void>;
}

export interface WizardPlan {
    preview: WizardPreview;
    /** One function per step of the preview, by id: it returns what it did, or throws `StepFailed`. */
    steps: Record<string, (ctx: StepCtx) => Promise<Said | void>>;
    /** Run when the run stops before its point of no return: `done` lists the steps that went through. */
    fallback(done: string[]): Promise<FallbackResult | null>;
    /** The folder's settings at the end. */
    settings(): unknown;
}

/** Why `answers` do not answer the preview's questions, or null when they do. */
export function answersRefusal(preview: WizardPreview, answers: Record<string, unknown>): string | null {
    for (const q of preview.questions) {
        const a = answers[q.id];
        if (q.kind === "confirm" && a !== true) return `${q.id}: confirm with true`;
        if (q.kind === "choose" && !(q.options ?? []).some((o) => o.key === a)) {
            return `${q.id}: one of ${(q.options ?? []).map((o) => o.key).join(", ")}`;
        }
    }
    return null;
}

export function newRun(id: string, cwd: string, preview: WizardPreview, nowIso: string): WizardRun {
    return {
        run: id, cwd, key: preview.key, value: preview.value, status: "running", started_at: nowIso, ended_at: null,
        steps: preview.steps.map((s) => ({ ...s, status: "pending", said: null, code: null })),
        fallback: null, settings: null,
    };
}

export interface RunHooks {
    answers: Record<string, unknown>;
    /** Called on every change of `run`, which is mutated in place. */
    changed(): void;
    cancelRequested(): boolean;
    sleep(ms: number): Promise<void>;
    now(): number;
    pollMs?: number;
}

/** Whether a cancellation is still possible: no point of no return has started. */
export function cancellable(run: WizardRun): boolean {
    return run.status === "running" && !run.steps.some((s) => s.point_of_no_return && s.status !== "pending");
}

/** Take `run` from its first step to its end; never throws. */
export async function runWizard(run: WizardRun, plan: WizardPlan, hooks: RunHooks): Promise<void> {
    const poll = hooks.pollMs ?? 1000;
    const done: string[] = [];
    let pastReturn = false;
    let end: RunStatus = "done";
    for (let i = 0; i < run.steps.length; i++) {
        const step = run.steps[i];
        if (!pastReturn && hooks.cancelRequested()) {
            end = "cancelled";
            break;
        }
        if (step.point_of_no_return) pastReturn = true;
        step.status = "running";
        hooks.changed();
        const ctx: StepCtx = {
            answers: hooks.answers,
            say: (what) => {
                step.said = what.said;
                step.code = what.code;
                if (what.details) step.details = what.details;
                hooks.changed();
            },
            waitUntil: async (ready, ms, waiting, timeout) => {
                const until = hooks.now() + ms;
                let last = "";
                for (;;) {
                    if (ready()) return;
                    if (!pastReturn && hooks.cancelRequested()) throw new StepCancelled();
                    if (hooks.now() >= until) throw new StepFailed(timeout());
                    const what = waiting();
                    const key = JSON.stringify(what);
                    if (key !== last) {
                        last = key;
                        ctx.say(what);
                    }
                    await hooks.sleep(poll);
                }
            },
        };
        try {
            const out = await (plan.steps[step.id] ?? (async () => { throw new StepFailed({ said: `no step ${step.id}`, code: "error" }); }))(ctx);
            if (out) {
                step.said = out.said;
                step.code = out.code;
                if (out.details) step.details = out.details;
            }
            step.status = "done";
            done.push(step.id);
            hooks.changed();
        } catch (e) {
            if (e instanceof StepCancelled) {
                step.status = "skipped";
                step.said = "Cancelled";
                step.code = "cancelled";
                end = "cancelled";
            } else {
                step.status = "failed";
                const what: Said = e instanceof StepFailed ? e.what : { said: `failed: ${(e as Error).message ?? e}`, code: "error" };
                step.said = what.said;
                step.code = what.code;
                if (what.details) step.details = what.details;
                end = "failed";
            }
            break;
        }
    }
    for (const s of run.steps) if (s.status === "pending") s.status = "skipped";
    if (end !== "done" && !pastReturn) {
        try {
            run.fallback = await plan.fallback(done);
        } catch (e) {
            run.fallback = { ran: false, said: `the fallback failed: ${(e as Error).message ?? e}`, code: "error" };
        }
    }
    try {
        run.settings = plan.settings();
    } catch {
        run.settings = null;
    }
    run.status = end;
    run.ended_at = new Date(hooks.now()).toISOString();
    hooks.changed();
}
