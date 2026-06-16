/**
 * #990 S3 — Boot replay from a CL_CAPTURE session.
 *
 * Re-drives the REAL boot machinery (the same pane watchers + `bootMachine`
 * the live loop wires in `loop.ts`) from a captured pane timeline, on a
 * VIRTUAL clock, and reports whether — and when — the boot phase sealed.
 *
 * This is the deterministic consumer of a capture : the live push-manager +
 * deadline-pump (`loop.ts` setIntervals on `Date.now()`) are simulated step
 * by step from the captured `t` stamps, so a recorded session reproduces its
 * exact boot outcome with no tmux, no claude, no wall-clock flakiness.
 *
 * Why it exists : a boot that ends on a `compact_confirm` whose
 * "Compact this conversation?" lingers in the footer never fires
 * `MODULE_ENDED` → the module stays active → the push manager pushes the
 * deadline forever → boot never seals. Replaying the captured panes proves
 * that mechanism (and, post-fix, proves it's gone) as a unit test.
 *
 * The proxy event stream (`proxy.ndjson`, keystrokes + injects) is merged
 * into the reported timeline for completeness but does NOT drive boot
 * sealing — only pane frames do. (The keystroke→action decider has its own
 * replay via `pty-proxy.py --replay-log`.)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createActor, type ActorRefFrom } from "xstate";
import { bootMachine } from "./boot-machine.js";
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
    /** Initial seal floor in ms (= live `CL_BOOT_MIN_SEC`). Default 30_000. */
    bootMinMs?: number;
    /** Post-module-end tunnel + push step. Default 10_000. */
    tunnelMs?: number;
    /** How long to keep pumping the virtual clock past the last pane frame
     *  before giving up and declaring "never sealed". Default 120_000. */
    tailMs?: number;
}

export interface ReplayPaneFrame {
    /** Epoch ms (captured `t` × 1000). */
    tMs: number;
    file: string;
    text: string;
}

export interface BootReplayResult {
    sealed: boolean;
    /** ms after the first frame at which boot sealed, or null. */
    sealedAtRelMs: number | null;
    sealReason: "deadline" | "hook" | null;
    /** Modules still active when the replay stopped (the smoking gun on a
     *  stuck boot — e.g. ["compact_confirm"]). */
    finalActiveModules: string[];
    /** Module begin/end edges in order, rel-ms stamped. */
    moduleEdges: Array<{ relMs: number; edge: "start" | "end"; name: string }>;
    paneFrameCount: number;
}

const PUMP_STEP_MS = 1000;

/** Map each watcher to the boot-module name it forwards, mirroring loop.ts. */
function buildBootObserver(): {
    obs: PaneObserver;
    wire: (onStart: (n: string) => void, onEnd: (n: string) => void) => void;
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

    const wire = (onStart: (n: string) => void, onEnd: (n: string) => void) => {
        const pairs: Array<[{ on: (e: "begin" | "end", cb: (s: unknown) => void) => unknown }, string]> = [
            [pickerSessionW, "resume_picker"],
            [pickerModeW, "resume_mode"],
            [resumingW, "resuming"],
            [compactConfirmW, "compact_confirm"],
            [compactingW, "compacting"],
        ];
        for (const [w, name] of pairs) {
            w.on("begin", () => onStart(name));
            w.on("end", () => onEnd(name));
        }
    };
    return { obs, wire };
}

/** Replay an already-loaded pane timeline. Pure over (frames, opts) — the
 *  unit-testable core. `loadCapture` is the IO wrapper around it. */
export function replayBootFrames(frames: ReplayPaneFrame[], opts: BootReplayOptions = {}): BootReplayResult {
    const bootMinMs = opts.bootMinMs ?? 30_000;
    const tunnelMs = opts.tunnelMs ?? 10_000;
    const tailMs = opts.tailMs ?? 120_000;

    const sorted = [...frames].sort((a, b) => a.tMs - b.tMs);
    const loopStartMs = sorted.length ? sorted[0].tMs : 0;

    const actor: ActorRefFrom<typeof bootMachine> = createActor(bootMachine, {
        input: { loopStartMs, bootMinMs, tunnelMs },
    });

    const moduleEdges: BootReplayResult["moduleEdges"] = [];
    let sealedAtMs: number | null = null;
    let sealReason: "deadline" | "hook" | null = null;
    let vnow = loopStartMs;

    const sealed = () => actor.getSnapshot().matches("sealed");

    actor.on("boot:sealed", (ev) => {
        if (sealedAtMs === null) {
            sealedAtMs = vnow;
            sealReason = ev.reason;
        }
    });
    actor.start();

    const sendIfBooting = (type: "MODULE_STARTED" | "MODULE_ENDED", name: string) => {
        if (!sealed()) actor.send({ type, name });
    };
    const { obs, wire } = buildBootObserver();
    wire(
        (name) => { if (!sealed()) { moduleEdges.push({ relMs: vnow - loopStartMs, edge: "start", name }); sendIfBooting("MODULE_STARTED", name); } },
        (name) => { if (!sealed()) { moduleEdges.push({ relMs: vnow - loopStartMs, edge: "end", name }); sendIfBooting("MODULE_ENDED", name); } },
    );

    // The capture dedups identical consecutive frames, but the LIVE loop
    // re-probes the same pane every heartbeat — so a held frame must be
    // re-ticked each step, else time-based latches (e.g. the compacting 10s
    // grace) would never expire in replay. `currentText` is the last frame
    // seen ; the pump re-ticks it.
    let currentText = "";

    // Advance the virtual clock to `toMs`, running — every PUMP_STEP — the
    // push manager + deadline pump (the two setIntervals in loop.ts) AND a
    // re-probe of the held pane (the heartbeat refreshPaneMarkers tick).
    const pumpTo = (toMs: number) => {
        while (vnow < toMs && !sealed()) {
            vnow = Math.min(vnow + PUMP_STEP_MS, toMs);
            const snap = actor.getSnapshot();
            if (snap.matches("booting")) {
                if (snap.context.activeModules.size > 0) actor.send({ type: "PUSH", nowMs: vnow });
                if (vnow >= actor.getSnapshot().context.deadlineMs) actor.send({ type: "DEADLINE_REACHED" });
            }
            obs.tick(currentText, { nowMs: vnow, isBoot: !sealed() });
        }
    };

    for (const f of sorted) {
        pumpTo(f.tMs);
        if (sealed()) break;
        currentText = f.text;
        obs.tick(f.text, { nowMs: f.tMs, isBoot: !sealed() });
    }
    // Tail : keep pumping so a clean boot's frozen deadline expires and
    // seals — and a stuck one (modules never cleared) provably does NOT.
    const lastMs = sorted.length ? sorted[sorted.length - 1].tMs : loopStartMs;
    pumpTo(lastMs + tailMs);

    const finalActiveModules = Array.from(actor.getSnapshot().context.activeModules);
    actor.stop(); // drop the real after(10s) timer scheduled on seal

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
