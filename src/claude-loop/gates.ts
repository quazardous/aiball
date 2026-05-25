/**
 * #428 — custom "gates" for the claude-loop wake.
 *
 * A gate is a check run at heartbeat whose MESSAGE is surfaced in the wake CTA
 * when it triggers — e.g. "you have an un-merged PR, resolve it before taking
 * new work". Generalises `check_cmd` (a single, binary, message-less wake
 * trigger) into N named checks, each carrying a message.
 *
 * Two forms, same result shape:
 *   - BUILT-IN (`type: unmerged_pr`) — pre-wired detector, zero shell to write
 *     (david #428: « gates au comportement pré-câblé pour besoins courants »).
 *   - CUSTOM   (`name, cmd, message`) — escape hatch: exit 0 = triggered,
 *     stdout (if any) overrides the static `message`.
 *
 * `blocks: true` → the wake LEADS with the gate and the `engage` directive is
 * suppressed by the caller ("resolve this before taking new work"); default is
 * warn (the message is just prepended to the normal CTA).
 *
 * Message WORDING is rendered by the CALLER via the prompt-template system
 * (renderSlot) — built-ins expose a slot + default + placeholder vars, so the
 * formulation is per-project overridable and tone-aware without this module
 * importing the template layer (david #428 « le message via le système de
 * prompt »). The pure part (`parseGates`) is unit-tested; the I/O (running
 * cmds / built-in detectors) lives behind `runGate` and fails open — a broken
 * gate never blocks the wake.
 */
import { spawnSync } from "node:child_process";

/** A parsed gate config entry. */
export interface GateSpec {
    /** Display / log name. Defaults to the built-in `type` or "gate". */
    name: string;
    /** Built-in detector key (see BUILTIN_GATES), if this is a pre-wired gate. */
    type?: string;
    /** Custom shell command (exit 0 = triggered). Mutually exclusive with type. */
    cmd?: string;
    /** Static message for a custom gate (stdout overrides it when non-empty). */
    message?: string;
    /** Block mode: lead the wake with this gate + suppress the engage directive. */
    blocks: boolean;
}

/** A triggered gate, ready for the caller to render + assemble. */
export interface GateResult {
    name: string;
    type?: string;
    blocks: boolean;
    /** prompt-template slot for the message (built-in only); undefined = custom. */
    slot?: string;
    /** literal/default message — fallback when no slot, or stdout for a custom gate. */
    message: string;
    /** placeholders the detector exposes (e.g. {count}) for renderSlot. */
    vars: Record<string, string>;
}

/** A pre-wired gate type. `detect` is the only I/O; keep it cheap (one tick). */
export interface BuiltinGate {
    /** Prompt slot carrying the default + per-project-overridable wording. */
    slot: string;
    /** Fallback wording when the slot is absent (placeholders still apply). */
    defaultMessage: string;
    detect: (cwd: string) => { triggered: boolean; vars: Record<string, string> };
}

/**
 * Pre-wired gate types for common needs. Add new ones here — the user enables
 * them by `type` with zero shell. Each detector fails open (returns
 * not-triggered on any error) so a missing tool never nags or crashes the wake.
 */
export const BUILTIN_GATES: Record<string, BuiltinGate> = {
    // Open PR(s) not merged on the loop's repo — "merge/handle before new work".
    unmerged_pr: {
        slot: "gate_unmerged_pr",
        defaultMessage: "⚠ {count} open PR(s) not merged — resolve before taking new work.",
        detect(cwd) {
            const r = spawnSync("gh", ["pr", "list", "--state", "open", "--json", "number"], {
                cwd,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            });
            const empty = { triggered: false, vars: {} as Record<string, string> };
            if (r.status !== 0 || !r.stdout) return empty;
            try {
                const n = (JSON.parse(r.stdout) as unknown[]).length;
                return { triggered: n > 0, vars: { count: String(n) } };
            } catch {
                return empty;
            }
        },
    },
};

/**
 * Parse the `claude_loop.gates` config list into specs. PURE + tolerant: a
 * malformed entry (object with neither a known `type` nor a `cmd`) is dropped,
 * never throws — a config typo must not break the wake (same posture as
 * `parseDrainedStrategy`).
 */
export function parseGates(raw: unknown): GateSpec[] {
    if (!Array.isArray(raw)) return [];
    const out: GateSpec[] = [];
    for (const e of raw) {
        if (!e || typeof e !== "object") continue;
        const o = e as Record<string, unknown>;
        const blocks = o.blocks === true;
        const type = typeof o.type === "string" && o.type.trim() ? o.type.trim() : undefined;
        const cmd = typeof o.cmd === "string" && o.cmd.trim() ? o.cmd.trim() : undefined;
        const message = typeof o.message === "string" ? o.message : undefined;
        const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : undefined;
        if (type) {
            if (!BUILTIN_GATES[type]) continue; // unknown built-in → drop silently
            out.push({ name: name ?? type, type, blocks });
        } else if (cmd) {
            out.push({ name: name ?? "gate", cmd, message, blocks });
        }
        // neither type nor cmd → drop
    }
    return out;
}

/** Run one gate (I/O). Returns null when it didn't trigger. */
export function runGate(spec: GateSpec, cwd: string): GateResult | null {
    if (spec.type) {
        const b = BUILTIN_GATES[spec.type];
        if (!b) return null;
        const { triggered, vars } = b.detect(cwd);
        if (!triggered) return null;
        return { name: spec.name, type: spec.type, blocks: spec.blocks, slot: b.slot, message: b.defaultMessage, vars };
    }
    if (spec.cmd) {
        const r = spawnSync("bash", ["-c", spec.cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        if (r.status !== 0) return null; // exit 0 = triggered (mirrors check_cmd)
        const stdout = (r.stdout ?? "").trim();
        const message = stdout || spec.message || `⚠ gate ${spec.name} triggered`;
        return { name: spec.name, blocks: spec.blocks, message, vars: {} };
    }
    return null;
}

/** Run every gate; drop the ones that didn't trigger. A throwing gate is
 *  swallowed (fail open) so it never blocks the wake. */
export function runGates(specs: GateSpec[], cwd: string): GateResult[] {
    const out: GateResult[] = [];
    for (const s of specs) {
        try {
            const r = runGate(s, cwd);
            if (r) out.push(r);
        } catch {
            /* a broken gate never blocks the wake */
        }
    }
    return out;
}
