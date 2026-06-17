/**
 * #990 S3 / #1009 — Boot replay from a CL_CAPTURE session.
 *
 * Re-drives the REAL boot machinery (the same pane watchers + `bootMachine`
 * the live loop wires in `loop.ts`) from a captured pane timeline, on a
 * VIRTUAL clock, and reports whether — and when — the boot phase sealed.
 *
 * #1009 LEVEL+DECAY : each virtual tick re-signals every CURRENTLY-VISIBLE boot
 * module to the machine (`MODULE_SEEN`), exactly like `refreshPaneMarkers`. The
 * machine seals when all modules (incl. the seed) have fallen out of their
 * remanence window — there's no begin/end pairing to get wrong (the #994
 * resume_mode leak class is structurally impossible).
 *
 * The proxy event stream (`proxy.ndjson`) is not replayed here (the keystroke
 * decider has its own `pty-proxy.py --replay-log`); only pane frames drive boot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createActor, type ActorRefFrom } from "xstate";
import { bootMachine, liveBootModules, DEFAULT_REMANENCE_MS } from "./boot-machine.js";
import { PaneObserver } from "./pane-watchers/observer.js";
import { Zone } from "./pane-watchers/zone.js";
import {
    PickerSessionWatcher,
    PickerModeWatcher,
    ResumingWatcher,
    CompactConfirmWatcher,
} from "./pane-watchers/boot-watchers.js";
import { CompactingDetector } from "./compacting-detector.js";

export interface BootReplayOptions {
    /** Seed module remanence (= boot floor, live `CL_BOOT_MIN_SEC`). Default 30_000. */
    bootMinMs?: number;
    /** Transient module remanence. Default 10_000. */
    remanenceMs?: number;
    /** How long to keep pumping past the last pane frame. Default 120_000. */
    tailMs?: number;
}

export interface ReplayPaneFrame {
    tMs: number;
    file: string;
    text: string;
}

export interface BootReplayResult {
    sealed: boolean;
    sealedAtRelMs: number | null;
    sealReason: "deadline" | "hook" | null;
    /** Modules still within their remanence window when the replay stopped
     *  (the smoking gun on a stuck boot — e.g. ["resume_mode"]). */
    finalActiveModules: string[];
    /** Module begin/end edges in order, rel-ms stamped (report only). */
    moduleEdges: Array<{ relMs: number; edge: "start" | "end"; name: string }>;
    paneFrameCount: number;
}

const PUMP_STEP_MS = 1000;

/** Maps each watcher to the boot-module name it represents, mirroring loop.ts. */
function buildBootObserver(): {
    obs: PaneObserver;
    /** Poll the watchers' current visibility → list of visible module names. */
    visibleModules: () => string[];
    /** Subscribe begin/end edges for the report (NOT for driving the machine). */
    onEdge: (cb: (edge: "start" | "end", name: string) => void) => void;
} {
    const pickerSessionW = new PickerSessionWatcher();
    const pickerModeW = new PickerModeWatcher();
    const resumingW = new ResumingWatcher();
    const compactConfirmW = new CompactConfirmWatcher();
    const compactingW = new CompactingDetector();

    const obs = new PaneObserver();
    obs.registerZone(new Zone("boot", [pickerSessionW, pickerModeW, resumingW, compactConfirmW]));
    obs.registerZone(new Zone("runtime", [compactingW]));
    obs.enter("boot");
    obs.enter("runtime");

    const pairs: Array<[{ snapshot: () => { visible?: boolean; active?: boolean }; on: (e: "begin" | "end", cb: () => void) => unknown }, string]> = [
        [pickerSessionW, "resume_picker"],
        [pickerModeW, "resume_mode"],
        [resumingW, "resuming"],
        [compactConfirmW, "compact_confirm"],
        [compactingW, "compacting"],
    ];

    const visibleModules = (): string[] => {
        const out: string[] = [];
        for (const [w, name] of pairs) {
            const s = w.snapshot();
            if (s.visible || s.active) out.push(name);
        }
        return out;
    };
    const onEdge = (cb: (edge: "start" | "end", name: string) => void): void => {
        for (const [w, name] of pairs) {
            w.on("begin", () => cb("start", name));
            w.on("end", () => cb("end", name));
        }
    };
    return { obs, visibleModules, onEdge };
}

/** Replay an already-loaded pane timeline. Pure over (frames, opts). */
export function replayBootFrames(frames: ReplayPaneFrame[], opts: BootReplayOptions = {}): BootReplayResult {
    const bootMinMs = opts.bootMinMs ?? 30_000;
    const remanenceMs = opts.remanenceMs ?? DEFAULT_REMANENCE_MS;
    const tailMs = opts.tailMs ?? 120_000;

    const sorted = [...frames].sort((a, b) => a.tMs - b.tMs);
    const loopStartMs = sorted.length ? sorted[0].tMs : 0;

    const actor: ActorRefFrom<typeof bootMachine> = createActor(bootMachine, {
        input: { loopStartMs, bootMinMs },
    });

    const moduleEdges: BootReplayResult["moduleEdges"] = [];
    let sealedAtMs: number | null = null;
    let sealReason: "deadline" | "hook" | null = null;
    let vnow = loopStartMs;

    const sealed = () => actor.getSnapshot().matches("sealed");
    actor.on("boot:sealed", (ev) => {
        if (sealedAtMs === null) { sealedAtMs = vnow; sealReason = ev.reason; }
    });
    actor.start();

    const { obs, visibleModules, onEdge } = buildBootObserver();
    onEdge((edge, name) => { if (!sealed()) moduleEdges.push({ relMs: vnow - loopStartMs, edge, name }); });

    // Re-signal every currently-visible module to the machine (= the per-tick
    // poll loop.ts does). Sealed → no-op.
    const signalVisible = (): void => {
        if (sealed()) return;
        for (const name of visibleModules()) {
            actor.send({ type: "MODULE_SEEN", name, nowMs: vnow, remanenceMs });
        }
    };

    // The capture dedups identical frames, but the live loop re-probes every
    // heartbeat — so re-tick the held frame each step (time-based latches +
    // the MODULE_SEEN poll need it).
    let currentText = "";
    const pumpTo = (toMs: number): void => {
        while (vnow < toMs && !sealed()) {
            vnow = Math.min(vnow + PUMP_STEP_MS, toMs);
            obs.tick(currentText, { nowMs: vnow, isBoot: !sealed() });
            signalVisible();
            if (!sealed() && vnow >= actor.getSnapshot().context.deadlineMs) {
                actor.send({ type: "DEADLINE_REACHED" });
            }
        }
    };

    for (const f of sorted) {
        pumpTo(f.tMs);
        if (sealed()) break;
        currentText = f.text;
        obs.tick(f.text, { nowMs: f.tMs, isBoot: !sealed() });
        signalVisible();
    }
    const lastMs = sorted.length ? sorted[sorted.length - 1].tMs : loopStartMs;
    pumpTo(lastMs + tailMs);

    const finalActiveModules = liveBootModules(actor.getSnapshot().context.moduleSeen, vnow)
        .filter((m) => m !== "boot"); // drop the seed from the "stuck" report
    actor.stop();

    return {
        sealed: sealedAtMs !== null,
        sealedAtRelMs: sealedAtMs === null ? null : sealedAtMs - loopStartMs,
        sealReason,
        finalActiveModules,
        moduleEdges,
        paneFrameCount: sorted.length,
    };
}

/** Load a CL_CAPTURE dir's pane timeline (panes.ndjson + referenced frames). */
export function loadCapturePaneFrames(captureDir: string): ReplayPaneFrame[] {
    const ndjson = join(captureDir, "panes.ndjson");
    const frames: ReplayPaneFrame[] = [];
    let raw: string;
    try {
        raw = readFileSync(ndjson, "utf8");
    } catch {
        return frames;
    }
    for (const line of raw.split("\n")) {
        const s = line.trim();
        if (!s) continue;
        let rec: { t?: number; file?: string };
        try {
            rec = JSON.parse(s);
        } catch {
            continue;
        }
        if (typeof rec.t !== "number" || typeof rec.file !== "string") continue;
        let text = "";
        try {
            text = readFileSync(join(captureDir, rec.file), "utf8");
        } catch {
            /* missing frame file — keep the row with empty text */
        }
        frames.push({ tMs: Math.round(rec.t * 1000), file: rec.file, text });
    }
    return frames;
}

/** Full replay from a capture dir. */
export function replayBootFromCapture(captureDir: string, opts: BootReplayOptions = {}): BootReplayResult {
    return replayBootFrames(loadCapturePaneFrames(captureDir), opts);
}
