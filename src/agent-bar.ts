/**
 * An agent's loop bar as DATA — what claude-loop paints in tmux's status line,
 * for any other host to draw its own way (tvty draws it under each terminal).
 *
 * The loop computes it next to the tmux paint and pushes it to the daemon on
 * change; the daemon keeps the latest per agent and serves it. So it carries
 * facts, never glyphs or colours, and times as absolute ISO dates, never
 * countdowns: a countdown is already wrong by the time another process reads it.
 *
 * Pure vocabulary, shared by both sides: the loop builds one, the daemon checks
 * one with `parseAgentBar`.
 */

export type BarPhase = "boot" | "idle" | "busy";
export type BarPresence = "boot" | "stop" | "wait" | "loop";
/** off = the loop runs on its own; wait_10m / wait_inf = held for a human. */
export type BarAfkMode = "off" | "wait_10m" | "wait_inf";
/** #3044 — who draws the bar: tmux's status line, or another host (tmux's line is off). */
export type BarHost = "tmux" | "external";
export const BAR_HOSTS: readonly BarHost[] = ["tmux", "external"];
export function isBarHost(v: unknown): v is BarHost {
    return typeof v === "string" && (BAR_HOSTS as readonly string[]).includes(v);
}

/**
 * #3066 — where a client attaches to the loop's Claude (docs/TVTY-BIND.md): its
 * socket when the loop runs on this machine's session host; otherwise why not —
 * `no_socket` for a loop in claude-loop's tmux (attach through tmux), `remote`
 * for one talking to a daemon on another machine (not attachable from here).
 */
export type BarAttach = { socket: string } | { socket: null; reason: "no_socket" | "remote" };

/** The attach a loop reports, from where it runs. Pure: its inputs are the kernel's environment. */
export function attachFor(o: { hostControl?: string | null; remoteUrl?: string | null }): BarAttach {
    if (o.hostControl) {
        // Beside control.sock, with the path's own separator (a Windows host's is `\`).
        const cut = Math.max(o.hostControl.lastIndexOf("/"), o.hostControl.lastIndexOf("\\"));
        return { socket: `${o.hostControl.slice(0, cut + 1)}attach.sock` };
    }
    // A daemon on this machine, reached over TCP, is not another machine.
    if (o.remoteUrl && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(o.remoteUrl)) return { socket: null, reason: "remote" };
    return { socket: null, reason: "no_socket" };
}

/**
 * #3514 — the bar's info word as a code and its parameters: `resuming`,
 * `compacting`, `wait`, `interrupted`, `user`; `picker` with `which`
 * (`session` | `mode`); `error` with `kind` (`rate_limit` | `overloaded` |
 * `api`); `retry` with `attempt`; `other` for a word a client should show raw
 * (`marker.info`). A client meeting a code it does not know shows `info`.
 */
export interface BarInfoCode {
    code: string;
    [param: string]: string | number;
}

/** #3686 — one window of the subscription's usage, as Claude Code's status line gives it. */
export interface BarUsageWindow {
    /** 0 to 100. */
    used_percentage: number;
    resets_at: string;
}

/**
 * #3686 — the subscription's usage (claude.ai Pro/Max), as Claude Code gives it
 * to its status line: each window null when absent, `read_at` when the loop read
 * it. The quota is the account's, so any agent's reading is the machine's.
 */
export interface BarUsage {
    five_hour: BarUsageWindow | null;
    seven_day: BarUsageWindow | null;
    read_at: string;
}

export interface AgentBar {
    /** What claude is doing. */
    phase: BarPhase;
    /** The human's relation to the loop (the bar's presence word). */
    presence: BarPresence;
    /** The AFK hold, and when a timed one lapses. */
    afk: { mode: BarAfkMode; expires_at: string | null };
    /** Claude's input zone: on screen, and holding unsent text. */
    prompt: { visible: boolean; has_input: boolean };
    /** A human typed in the loop's terminal within the last few seconds. */
    human_typing: boolean;
    /**
     * What the state marker says besides the phase: a transient info word
     * (`retry 3`, `compacting`, `resuming`, `wait`, `interrupted`) and the
     * dialogs waiting for an answer.
     */
    marker: {
        info: string | null; health_prompt: boolean; resume_picker: boolean; resume_mode_picker: boolean;
        /** #3514 — `info` as data, for a client that writes it in its own language; null when no word. Optional: absent from loops started before it. */
        info_code?: BarInfoCode | null;
    };
    /** Conditions a host should show loudly. */
    alerts: { link_down: boolean; daemon_down: boolean; not_logged_in: boolean; trust_dialog: boolean; api_unreachable: boolean; restart_needed: boolean; restart_pending: boolean; limit_reached: boolean };
    /** #3268 — when a reached usage limit lifts, as Claude Code says it (`at` when it can be read as a moment); null when none is reached. */
    limit_resets: { text: string; at: string | null } | null;
    /** #3283 — the model Claude ran its last turn on: its id and short name ("Opus 5.5"); null before the first turn ends. Optional: absent from loops started before it. */
    model?: {
        id: string;
        name: string;
        /** #3288 — added by the daemon from its model catalog (never sent by a loop): the price, USD per million tokens. */
        cost?: { input: number; output: number } | null;
        /** #3288 — a newer model of the same family, when the catalog knows one: what a host colours the name for. */
        newer?: { id: string; name: string; cost: { input: number; output: number } | null } | null;
        /** #3288 — where the price and `newer` come from: an open list, kept by its community. */
        catalog?: "models.dev" | "litellm";
    } | null;
    /** #3500 — the tool calls Claude Code's permission system denied (the auto mode classifier, a deny rule): how many in the last hour, since the loop's start, when the last came and why; null when none in the last hour. Optional: absent from loops started before it. */
    denials?: { last_hour: number; total: number; last_at: string; last_reason: string | null; /** #3509 — the prompts sent for repeated denials in the last hour; absent before it. */ sent?: number } | null;
    /** #3686 — the subscription's usage (5-hour and weekly windows); null when Claude Code gives none (an API key, before the first answer). Optional: absent from loops started before it. */
    usage?: BarUsage | null;
    /** #3291 — whether Claude is in Remote Control now, as its status line shows it (the flag at start or a `/rc` in the session). Optional: absent from loops started before it. */
    remote_control?: { on: boolean };
    /** The PTY proxy fronting claude is alive. */
    proxy_alive: boolean;
    /** Zen mode is on. */
    zen: boolean;
    /** The loop's counters: open tickets, backlog, events; null before the first read. */
    counters: { open: number | null; backlog: number | null; events: number | null } | null;
    /** When the next wake is due, while idle with something to drain. */
    next_wake_at: string | null;
    /** While booting: when the boot started, and when its grace ends. */
    boot: { started_at: string; deadline_at: string | null } | null;
    /** #3044 — who draws the bar: `tmux` (its status line) or `external` (tmux's line is off). */
    host: BarHost;
    /** #3066 — where a client attaches (see `BarAttach`); a loop older than the field reports none: `no_socket`. */
    attach: BarAttach;
}

const PHASES: readonly string[] = ["boot", "idle", "busy"];
const PRESENCES: readonly string[] = ["boot", "stop", "wait", "loop"];
const AFK_MODES: readonly string[] = ["off", "wait_10m", "wait_inf"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isDateOrNull = (v: unknown): v is string | null => v === null || (typeof v === "string" && Number.isFinite(Date.parse(v)));
const isCountOrNull = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0);

/** A checked `usage`, with its unknown fields dropped. */
function usageCopy(u: Record<string, unknown>): BarUsage {
    const win = (w: unknown): BarUsageWindow | null => isObj(w) ? { used_percentage: w.used_percentage as number, resets_at: w.resets_at as string } : null;
    return { five_hour: win(u.five_hour), seven_day: win(u.seven_day), read_at: u.read_at as string };
}

/** The bar a loop pushed, or why it is refused. Unknown fields are dropped. */
export function parseAgentBar(input: unknown): AgentBar | { error: string } {
    if (!isObj(input)) return { error: "the bar must be an object" };
    const b = input;
    if (typeof b.phase !== "string" || !PHASES.includes(b.phase)) return { error: `phase must be one of ${PHASES.join(", ")}` };
    if (typeof b.presence !== "string" || !PRESENCES.includes(b.presence)) return { error: `presence must be one of ${PRESENCES.join(", ")}` };
    if (!isObj(b.afk) || typeof b.afk.mode !== "string" || !AFK_MODES.includes(b.afk.mode) || !isDateOrNull(b.afk.expires_at)) {
        return { error: `afk must be { mode: ${AFK_MODES.join(" | ")}, expires_at: ISO date | null }` };
    }
    if (!isObj(b.prompt) || !isBool(b.prompt.visible) || !isBool(b.prompt.has_input)) return { error: "prompt must be { visible, has_input } booleans" };
    if (!isBool(b.human_typing)) return { error: "human_typing must be a boolean" };
    const m = b.marker;
    if (!isObj(m) || !(m.info === null || typeof m.info === "string") || !isBool(m.health_prompt) || !isBool(m.resume_picker) || !isBool(m.resume_mode_picker)) {
        return { error: "marker must be { info: string | null, health_prompt, resume_picker, resume_mode_picker }" };
    }
    // #3514 — optional: absent from loops started before it.
    const ic = m.info_code;
    if (!(ic === undefined || ic === null || (isObj(ic) && typeof ic.code === "string" && ic.code
        && Object.values(ic).every((v) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))))) {
        return { error: "marker.info_code must be null or { code: string, ...params: string | number }" };
    }
    const a = b.alerts;
    if (!isObj(a) || !isBool(a.link_down) || !isBool(a.daemon_down) || !isBool(a.not_logged_in) || !isBool(a.trust_dialog) || !isBool(a.api_unreachable)
        // #3074 — optional: a loop started before it existed does not send it.
        || (a.restart_needed !== undefined && !isBool(a.restart_needed))
        // #3117 — optional too, for the same reason.
        || (a.restart_pending !== undefined && !isBool(a.restart_pending))
        // #3268 — optional too.
        || (a.limit_reached !== undefined && !isBool(a.limit_reached))) {
        return { error: "alerts must be { link_down, daemon_down, not_logged_in, trust_dialog, api_unreachable, restart_needed?, restart_pending?, limit_reached? } booleans" };
    }
    // #3268 — absent from loops started before the field.
    const lr = b.limit_resets;
    if (!(lr === undefined || lr === null || (isObj(lr) && typeof lr.text === "string" && isDateOrNull(lr.at)))) {
        return { error: "limit_resets must be null or { text, at: ISO date | null }" };
    }
    // #3283 — absent from loops started before the field.
    const md = b.model;
    if (!(md === undefined || md === null || (isObj(md) && typeof md.id === "string" && md.id && typeof md.name === "string" && md.name))) {
        return { error: "model must be null or { id, name } strings" };
    }
    // #3291 — absent from loops started before the field.
    const rc = b.remote_control;
    if (!(rc === undefined || (isObj(rc) && isBool(rc.on)))) return { error: "remote_control must be { on: boolean }" };
    // #3500 — absent from loops started before the field; #3507 — checked and kept here, or no client ever saw it.
    const dn = b.denials;
    if (!(dn === undefined || dn === null || (isObj(dn) && isCountOrNull(dn.last_hour) && dn.last_hour !== null
        && isCountOrNull(dn.total) && dn.total !== null && typeof dn.last_at === "string" && isDateOrNull(dn.last_at)
        && (dn.last_reason === null || typeof dn.last_reason === "string")
        && (dn.sent === undefined || (isCountOrNull(dn.sent) && dn.sent !== null))))) {
        return { error: "denials must be null or { last_hour, total: counts, last_at: ISO date, last_reason: string | null, sent?: count }" };
    }
    // #3686 — absent from loops started before the field.
    const us = b.usage;
    const isWindow = (w: unknown) => w === null || (isObj(w) && typeof w.used_percentage === "number" && Number.isFinite(w.used_percentage)
        && w.used_percentage >= 0 && typeof w.resets_at === "string" && isDateOrNull(w.resets_at));
    if (!(us === undefined || us === null || (isObj(us) && isWindow(us.five_hour) && isWindow(us.seven_day)
        && typeof us.read_at === "string" && isDateOrNull(us.read_at)))) {
        return { error: "usage must be null or { five_hour, seven_day: null | { used_percentage: number, resets_at: ISO date }, read_at: ISO date }" };
    }
    if (!isBool(b.proxy_alive) || !isBool(b.zen)) return { error: "proxy_alive and zen must be booleans" };
    const c = b.counters;
    if (!(c === null || (isObj(c) && isCountOrNull(c.open) && isCountOrNull(c.backlog) && isCountOrNull(c.events)))) {
        return { error: "counters must be null or { open, backlog, events } counts" };
    }
    if (!isDateOrNull(b.next_wake_at)) return { error: "next_wake_at must be an ISO date or null" };
    const boot = b.boot;
    if (!(boot === null || (isObj(boot) && typeof boot.started_at === "string" && isDateOrNull(boot.started_at) && isDateOrNull(boot.deadline_at)))) {
        return { error: "boot must be null or { started_at: ISO date, deadline_at: ISO date | null }" };
    }
    // #3044 — absent from loops started before the field: they draw in tmux.
    if (b.host !== undefined && !isBarHost(b.host)) return { error: `host must be one of ${BAR_HOSTS.join(", ")}` };
    // #3066 — absent from loops started before the field.
    let attach: BarAttach | undefined;
    if (b.attach !== undefined) {
        const at = b.attach;
        if (isObj(at) && typeof at.socket === "string" && at.socket) attach = { socket: at.socket };
        else if (isObj(at) && at.socket === null && (at.reason === "no_socket" || at.reason === "remote")) attach = { socket: null, reason: at.reason };
        else return { error: 'attach must be { socket: path } or { socket: null, reason: "no_socket" | "remote" }' };
    }
    return {
        phase: b.phase as BarPhase,
        presence: b.presence as BarPresence,
        afk: { mode: b.afk.mode as BarAfkMode, expires_at: b.afk.expires_at as string | null },
        prompt: { visible: b.prompt.visible as boolean, has_input: b.prompt.has_input as boolean },
        human_typing: b.human_typing,
        marker: {
            info: m.info as string | null, health_prompt: m.health_prompt as boolean, resume_picker: m.resume_picker as boolean, resume_mode_picker: m.resume_mode_picker as boolean,
            ...(m.info_code === undefined ? {} : { info_code: m.info_code === null ? null : { ...(m.info_code as BarInfoCode) } }),
        },
        alerts: { link_down: a.link_down as boolean, daemon_down: a.daemon_down as boolean, not_logged_in: a.not_logged_in as boolean, trust_dialog: a.trust_dialog as boolean, api_unreachable: a.api_unreachable as boolean, restart_needed: a.restart_needed === true, restart_pending: a.restart_pending === true, limit_reached: a.limit_reached === true },
        limit_resets: isObj(lr) ? { text: lr.text as string, at: (lr.at as string | null) ?? null } : null,
        model: isObj(md) ? { id: md.id as string, name: md.name as string } : null,
        remote_control: { on: isObj(rc) && rc.on === true },
        ...(dn === undefined ? {} : { denials: isObj(dn) ? { last_hour: dn.last_hour as number, total: dn.total as number, last_at: dn.last_at as string, last_reason: (dn.last_reason as string | null) ?? null, ...(dn.sent === undefined ? {} : { sent: dn.sent as number }) } : null }),
        ...(us === undefined ? {} : { usage: isObj(us) ? usageCopy(us) : null }),
        proxy_alive: b.proxy_alive,
        zen: b.zen,
        counters: c === null ? null : { open: (c as Record<string, number | null>).open!, backlog: (c as Record<string, number | null>).backlog!, events: (c as Record<string, number | null>).events! },
        next_wake_at: b.next_wake_at as string | null,
        boot: boot === null ? null : { started_at: (boot as Record<string, string>).started_at!, deadline_at: (boot as Record<string, string | null>).deadline_at ?? null },
        host: b.host === undefined ? "tmux" : b.host as BarHost,
        attach: attach ?? { socket: null, reason: "no_socket" },
    };
}
