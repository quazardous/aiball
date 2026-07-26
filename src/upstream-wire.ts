/**
 * #1563 slice 3 — choosing the wire.
 *
 * The transports themselves live in `upstream-transport.ts`; this module owns
 * the one question they don't answer: **which one carries this call**.
 *
 * ## The rule
 *
 * Layered like every other knob in aiball (`docs/CONFIGS.md`): a host-level
 * default (`upstream_transport:` in the global config) that a per-binding
 * `transport:` overrides. Availability is a property of the machine — whether
 * `gh` is installed and logged in — while reachability and identity are
 * properties of the repo, so both levels are needed and neither alone suffices.
 *
 * ## Why `auto` prefers `gh`
 *
 * `gh` borrows the CLI's keyring credential, so it reaches private repos
 * **without any secret written into a config file**. An HTTP wire with no token
 * only sees public repos at a low rate limit; an HTTP wire with a token means a
 * plaintext secret on disk. Defaulting to `http` would make the zero-secret
 * path unreachable unless the user goes and configures something, which is
 * backwards — hence `auto` first, `gh` first within it.
 *
 * ## Resolution is dynamic, execution is not
 *
 * `auto` probes ONCE per process, caches the answer and logs it. After that the
 * choice is fixed: if the chosen wire breaks, the error surfaces as-is. There is
 * no retry on the other transport — a silent gh→http rescue would hide a broken
 * `gh` for weeks, until the day HTTP fails too. That is the exact failure this
 * ticket exists to prevent, so the fallback lives in *selection*, never in
 * *execution*.
 */
import {
    upstreamToken,
    upstreamTransportChoice,
    type TransportChoice,
} from "./autopoll/config.js";
import {
    ghTransport,
    httpTransport,
    type TransportProbe,
    type UpstreamTransport,
} from "./upstream-transport.js";

export interface ResolveWireOpts {
    /** Per-binding override; falls back to the host-level choice when absent. */
    choice?: TransportChoice;
    /** Provider id, for the token lookup on the HTTP wire. */
    kind?: string;
    token?: string | null;
    fetchImpl?: typeof fetch;
    /** Tests inject stubs instead of touching config / spawning `gh`. */
    transports?: { http: UpstreamTransport; gh: UpstreamTransport };
    /** Silences the one-time resolution log (tests). */
    quiet?: boolean;
}

/** What `auto` decided, and on what evidence. Surfaced by diagnostics. */
export interface WireDecision {
    id: "http" | "gh";
    /** How it was picked: explicit config, or probed. */
    via: "configured" | "probed";
    /** The probe detail of the winner (or of `http` when nothing probed ok). */
    detail: string;
    /** Every candidate's probe result — the readable part of "why this one". */
    probes: Array<{ id: "http" | "gh"; ok: boolean; detail: string }>;
}

/** Memoized `auto` outcome. One probe per process, not per request. */
let autoDecision: WireDecision | null = null;

/** Test seam — forget the cached `auto` decision. */
export function resetWireCache(): void {
    autoDecision = null;
}

function build(opts: ResolveWireOpts): { http: UpstreamTransport; gh: UpstreamTransport } {
    if (opts.transports) return opts.transports;
    const token = opts.token ?? (opts.kind ? upstreamToken(opts.kind) : null);
    return {
        http: httpTransport({ token, fetchImpl: opts.fetchImpl }),
        gh: ghTransport(),
    };
}

/**
 * PURE-ish — decide which wire to use, probing only when the choice is `auto`.
 * Returns the transport plus the decision, so callers can report it.
 */
export async function resolveWire(
    opts: ResolveWireOpts = {},
): Promise<{ wire: UpstreamTransport; decision: WireDecision }> {
    const t = build(opts);
    const choice: TransportChoice = opts.choice ?? upstreamTransportChoice();

    // Explicit wins outright — no probe, no second-guessing. Asking for `gh`
    // on a machine without it must FAIL, loudly, at call time; silently
    // downgrading to http is the behaviour this ticket forbids.
    if (choice === "http" || choice === "gh") {
        const wire = t[choice];
        const probe = await wire.probe();
        return {
            wire,
            decision: {
                id: choice,
                via: "configured",
                detail: probe.detail,
                probes: [{ id: choice, ok: probe.ok, detail: probe.detail }],
            },
        };
    }

    if (autoDecision) return { wire: t[autoDecision.id], decision: autoDecision };

    // `gh` first: the zero-secret path. `http` is the floor — its probe always
    // passes (public repos work unauthenticated), so `auto` always resolves.
    const order: Array<"gh" | "http"> = ["gh", "http"];
    const probes: WireDecision["probes"] = [];
    let winner: { id: "gh" | "http"; probe: TransportProbe } | null = null;
    for (const id of order) {
        const probe = await t[id].probe();
        probes.push({ id, ok: probe.ok, detail: probe.detail });
        if (probe.ok && !winner) winner = { id, probe };
    }
    const picked = winner ?? { id: "http" as const, probe: { ok: true, detail: "http: fallback" } };
    autoDecision = { id: picked.id, via: "probed", detail: picked.probe.detail, probes };
    if (!opts.quiet) {
        console.log(`[upstream] transport auto → ${picked.id} (${picked.probe.detail})`);
    }
    return { wire: t[picked.id], decision: autoDecision };
}

/** Probe every transport regardless of the configured choice — for `aiball check`. */
export async function probeAllWires(
    opts: ResolveWireOpts = {},
): Promise<{ choice: TransportChoice; probes: WireDecision["probes"] }> {
    const t = build(opts);
    const choice: TransportChoice = opts.choice ?? upstreamTransportChoice();
    const probes: WireDecision["probes"] = [];
    for (const id of ["gh", "http"] as const) {
        const p = await t[id].probe();
        probes.push({ id, ok: p.ok, detail: p.detail });
    }
    return { choice, probes };
}
