/**
 * #748 + #727 V1 Slice B-4 — helpers for yaml unit scenarios that need
 * a tmp state-dir + an IPC state mutation before calling a pure fn.
 *
 * The yaml runner (`yaml-scenarios.test.ts`) calls a function with the
 * args list verbatim. For state-machine assertions that need a tmp
 * file fixture + an in-memory `IpcState` override (e.g. validating the
 * Slice B push-state path), this module exposes one entry point :
 * `readLoopStateWithIpc(opts)` writes the requested files into a fresh
 * tmp dir, mutates the singleton IPC state, calls `readLoopStateInput`,
 * then resets the state for the next scenario.
 *
 * Why a TS helper instead of inlining the wiring in yaml : the yaml
 * runner is intentionally a thin dispatcher (no scripting), and the
 * setup logic here is real code that benefits from type checks.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    getIpcState,
    resetIpcStateForTests,
    setIpcAfk,
    setIpcBootComplete,
    setIpcBusyDeferUntil,
    setIpcHumanTypingAtMs,
    setIpcIdleSince,
    setIpcResumeModePicker,
    setIpcResumeSessionPicker,
} from "./ipc-state.js";
import { readLoopStateInput } from "./state.js";

export interface ReadLoopStateWithIpcOpts {
    /** Sentinel `"TMPDIR"` = create a fresh tmp state-dir for the call,
     *  otherwise use the literal path provided. */
    sd: string;
    /** Marker files to seed into the state-dir before the call.
     *  Sentinels in the content : `"FRESH_ISO"` = current time ISO,
     *  `"BOOT_ISO"` = current time minus 10 minutes. */
    files?: Record<string, string>;
    /** IpcState overrides applied before the call. Fields left
     *  undefined keep the post-reset null defaults. */
    ipc?: {
        bootComplete?: boolean | null;
        idleSinceMs?: number | null;
        idleSinceCleared?: boolean;
        busyDeferUntilMs?: number | null;
        resumeSessionPickerActive?: boolean | null;
        resumeModePickerActive?: boolean | null;
        afkMode?: "off" | "wait_10m" | "wait_inf" | null;
        afkExpiryMs?: number | null;
        humanTypingAtMs?: number | null;
    };
    /** Passed through to `readLoopStateInput`. `nowMs` is not part of
     *  the function signature — the scenarios that care about it use
     *  the helper's wall clock. */
    readOpts?: { manualWake?: boolean };
}

function resolveSentinel(value: string): string {
    if (value === "FRESH_ISO") return new Date().toISOString() + "\n";
    if (value === "BOOT_ISO") return new Date(Date.now() - 10 * 60_000).toISOString() + "\n";
    return value;
}

export function readLoopStateWithIpc(opts: ReadLoopStateWithIpcOpts): ReturnType<typeof readLoopStateInput> {
    resetIpcStateForTests();
    const sd = opts.sd === "TMPDIR"
        ? mkdtempSync(join(tmpdir(), "yaml-ipc-"))
        : opts.sd;
    try {
        if (opts.files) {
            for (const [name, content] of Object.entries(opts.files)) {
                writeFileSync(join(sd, name), resolveSentinel(content));
            }
        }
        const ipc = opts.ipc ?? {};
        if (ipc.bootComplete !== undefined) setIpcBootComplete(ipc.bootComplete as boolean);
        if (ipc.idleSinceMs !== undefined) {
            setIpcIdleSince(ipc.idleSinceMs);
            // setIpcIdleSince(null) sets idleSinceCleared=true automatically ;
            // honour an explicit override when the scenario asks for it.
            if (ipc.idleSinceCleared !== undefined) {
                (getIpcState() as { idleSinceCleared: boolean }).idleSinceCleared = ipc.idleSinceCleared;
            }
        } else if (ipc.idleSinceCleared) {
            setIpcIdleSince(null);
        }
        if (ipc.busyDeferUntilMs !== undefined) setIpcBusyDeferUntil(ipc.busyDeferUntilMs);
        if (ipc.resumeSessionPickerActive !== undefined) setIpcResumeSessionPicker(ipc.resumeSessionPickerActive);
        if (ipc.resumeModePickerActive !== undefined) setIpcResumeModePicker(ipc.resumeModePickerActive);
        if (ipc.afkMode !== undefined) setIpcAfk(ipc.afkMode, ipc.afkExpiryMs ?? null);
        if (ipc.humanTypingAtMs !== undefined) setIpcHumanTypingAtMs(ipc.humanTypingAtMs);
        return readLoopStateInput(sd, opts.readOpts ?? {});
    } finally {
        if (opts.sd === "TMPDIR") {
            try { rmSync(sd, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        resetIpcStateForTests();
    }
}
