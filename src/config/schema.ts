/**
 * #449 — the unified config SCHEMA: the single, in-code source of truth for
 * daemon-stored config keys. Each entry declares a key's layering scope, value
 * type, default, and whether it's protected (admin-only). The storage half
 * (overrides) lives in `src/db/config-overrides.ts` + the `config_overrides`
 * table; the layered read resolves project → global → this default.
 *
 * Why code (not JSON): strong typing, validation, and colocation with the read
 * layer — there's no external config file to load here, so JSON buys nothing.
 *
 * Scope of THIS framework: daemon-DB config shared by every loop that talks to
 * the daemon. The per-machine FILE config (`.aiball.yaml`, global yaml) is a
 * separate layer (see docs/CONFIGS.md) and is intentionally NOT modelled here.
 *
 * Existing dedicated settings (moderation strategy, upload-max-bytes, tags) keep
 * their own storage for now; they migrate onto this framework incrementally.
 */
import { parseDuration } from "./duration.js";

/** Where a key may be overridden. */
export type ConfigScope =
    | "global" // one daemon-wide value; no per-project override
    | "global+project" // a global default that a project may override
    | "project"; // only meaningful per project (no global value)

/** #3138 — `duration`: seconds on the wire; `config.set` also takes the
 *  notation (`1h30m`, src/config/duration.ts). */
export type ConfigValueType = "string" | "number" | "boolean" | "enum" | "duration";

export type ConfigValue = string | number | boolean;

/** #3137 — what a number counts, for a client to label it and step through it. */
export type ConfigUnit = "characters" | "count" | "lines" | "times";

/** #590 — where a key can be SET. `db` = SQLite `config_overrides` table
 *  (UI admin Settings). `file` = .aiball.yaml / global yaml. A key may
 *  declare either, both, or (rare) none. */
export type ConfigSource = "db" | "file";

export interface ConfigSchemaEntry {
    /** Dotted key, e.g. `tickets.default_priority`. Unique across the schema. */
    key: string;
    scope: ConfigScope;
    type: ConfigValueType;
    /** The shipped default when no override exists at any layer. */
    default: ConfigValue;
    /** enum only: the allowed values. */
    options?: readonly string[];
    /**
     * Protected = write reserved to owner/moderator and rendered read-only in
     * the public UI (#449). Default false (anyone with admin access can set it).
     */
    protected?: boolean;
    /** #3137, #3138 — number or duration: the accepted range (inclusive;
     *  `config.set` refuses outside it, CONFIG_OUT_OF_RANGE) and the step a
     *  client moves by, a duration's in seconds; and what a number counts. The
     *  section is the key's path less its last segment (`groupOf`), and the
     *  display order this list's order, a contract. */
    min?: number;
    max?: number;
    step?: number;
    unit?: ConfigUnit;
    /** Human label + one-line help for the settings UI. */
    label: string;
    description: string;
    /** #590 — storage locations for this key, ordered by default precedence.
     *  When unset, defaults to `["db"]` (backwards compat with the #449 model).
     *  Set `["file"]` for per-tree-committed settings (e.g. claude-loop knobs),
     *  or `["db", "file"]` to allow either (UI override wins unless `precedence`
     *  flips it). */
    sources?: readonly ConfigSource[];
    /** #590 — explicit precedence when `sources.length === 2`. Default `"db"`
     *  (UI override wins over the committed yaml). Set `"file"` for the rare
     *  case where the per-tree value MUST win (e.g. a checked-in policy). */
    precedence?: ConfigSource;
}

/**
 * The seed registry. Add a key here and it's automatically available to the
 * layered read, the REST surface, and (next slice) the generic settings UI —
 * no per-key router/panel wiring. `tickets.default_priority` is wired through to
 * ticket creation as the first real consumer (proof of the end-to-end path);
 * the others are declared and consumed as each gets wired.
 */
export const CONFIG_SCHEMA: readonly ConfigSchemaEntry[] = [
    // #2586 — the daemon asks GitHub for the latest release when it starts.
    {
        key: "updates.check",
        scope: "global",
        type: "boolean",
        default: true,
        sources: ["db", "file"],
        label: "Check for updates",
        description:
            "true (default) = when the daemon starts, and when someone asks, it reads the latest aiball release on GitHub so the tray, the GNOME extension and `aiball version` can say an update is out. false = no outbound call.",
    },
    // #449 — DB-source ticket defaults (admin Settings).
    {
        key: "tickets.defaults.priority",
        scope: "global+project",
        type: "enum",
        options: ["low", "normal", "high", "urgent"],
        default: "normal",
        label: "Default ticket priority",
        description:
            "Priority applied to a new ticket created without an explicit one. Set a global default; a project may override it.",
    },
    {
        key: "tickets.defaults.broadcast_new",
        scope: "global+project",
        type: "boolean",
        default: false,
        label: "Broadcast new tickets by default",
        description:
            "When on, a new ticket with no explicit scope is flagged broadcast (project followers are pinged). Declared; enforcement lands with its consumer.",
    },
    // #2203 — the summary budget. Refused, never truncated: a cut summary loses
    // its end, which is where the next step usually sits. Protected, so an agent
    // cannot loosen the budget it is held to.
    {
        key: "tickets.rules.summary_max",
        min: 0,
        max: 5000,
        step: 50,
        unit: "characters",
        scope: "global+project",
        type: "number",
        default: 500,
        protected: true,
        label: "Summary budget (characters)",
        description:
            "Longest summary_until an agent may write on a comment. A longer one is refused with an explanation and nothing is posted; it is never truncated. Humans are exempt. 0 = no limit.",
    },
    // #2275 / #2331 — a comment from an agent must carry a `then` or say whether
    // it hands the ticket back (`handback`). Protected, so an agent cannot
    // switch off the rule it is held to; a moderator can, per project, for a
    // loop that cannot be reloaded to learn the new flag.
    {
        key: "tickets.rules.require_then",
        scope: "global+project",
        type: "boolean",
        default: true,
        protected: true,
        label: "Agent comments need then: or handback",
        description:
            "When on, an agent's comment with no then: must set handback (true: it hands the ticket back, false: it keeps it), or it is refused with an explanation and nothing is posted. Humans are exempt.",
    },
    // #2652 david — « il faut que le champ commit soit obligatoire ».
    {
        key: "tickets.rules.require_commits",
        scope: "global+project",
        type: "boolean",
        default: true,
        protected: true,
        label: "Agent comments need commits",
        description:
            "When on, an agent's comment must say which commits it delivers (commits: [\"<sha>\"]) or that it delivers none (commits: null or \"none\"), or it is refused with an explanation. A client from before the field is warned instead of refused until it reconnects. Humans, close and reopen are exempt.",
    },
    // #2308 — a step (`then: continue`) keeps a ticket in its author's pool; one
    // that nothing follows is flagged in the inbox after this many hours.
    {
        key: "tickets.steps.stale",
        min: 3600,
        max: 2592000,
        step: 3600,
        scope: "global+project",
        type: "duration",
        default: 86400,
        label: "Stalled step after",
        description:
            "A step (then: continue) with nothing after it for this long is flagged in the inbox: the work it announced went quiet. 0 = never flag.",
    },
    // #2365 — a step says there is work to do now: the backlog wake that follows
    // it sinks the ticket only briefly, long enough to turn the queue over.
    // #2379 david `prrg57` — "claim est une version faible de assign… tant
    // qu'un agent est actif sur un ticket son claim est protégé pendant X
    // minutes". Shorter and harder than the claim's liveness window
    // (assign_window_sec): that one HIDES the ticket from other pools, this one
    // REFUSES the take-over outright.
    // #2449 david — a step (then: continue) says "I carry on": its ticket goes
    // to the top of its author's backlog for a while, right after the events.
    {
        key: "tickets.steps.hot",
        min: 60,
        max: 86400,
        step: 300,
        scope: "global+project",
        type: "duration",
        default: 1800,
        label: "Minutes a step keeps its ticket at the top of its author's backlog",
        description:
            "After an agent posts a step (then: continue), its ticket leads that agent's backlog — right after the events, ahead of every other ticket — for this long, counted from the step. Past it, the ticket ranks like any other. It only changes the order; the visible 'hot' mark keeps its own rule. 0 = a step gets no priority.",
    },
    // #2481 david — "c'est 2h le max (modifiable par projet en conf)".
    {
        key: "tickets.steps.max_wait",
        min: 60,
        max: 86400,
        step: 300,
        scope: "global+project",
        type: "duration",
        default: 7200,
        label: "Longest wait a step may declare",
        description:
            "The most an agent may put in resume_on.timer on a step (then: continue). A longer wait is refused with this limit in the reason — past it the work is not one step waiting on a job any more: hand the ticket back, or propose a plan.",
    },
    // #2640 david — the wait credit: « les minutes qu'on attend sont prises sur un budget temps qu'on doit gagner par preuve de travail ».
    {
        key: "tickets.wait_credit.enabled",
        scope: "global+project",
        type: "boolean",
        default: true,
        label: "Wait credit",
        description:
            "true (default) = a step's resume_on.timer spends an agent's wait credit, earned by proof of work. false = waits are free and uncapped (still at most tickets.step_after_max_minutes), nothing is earned, spent or refunded, and replies and wakes say nothing about credit.",
    },
    {
        key: "tickets.wait_credit.refund",
        scope: "global+project",
        type: "boolean",
        default: true,
        label: "Wait credit: refund an early return",
        description:
            "true (default) = an agent speaking on a ticket again before its step's wait ends gets the rest of that wait back. false = a wait is spent in full once declared.",
    },
    {
        key: "tickets.wait_credit.earn.commit_max_age",
        min: 3600,
        max: 2592000,
        step: 3600,
        scope: "global+project",
        type: "duration",
        default: 172800,
        label: "Wait credit: oldest commit that still earns",
        description:
            "A cited commit whose commit date is older than this earns nothing: the credit rewards fresh work.",
    },
    {
        key: "tickets.wait_credit.earn.commits_per_comment",
        min: 1,
        max: 100,
        step: 1,
        unit: "count",
        scope: "global+project",
        type: "number",
        default: 20,
        label: "Wait credit: commits counted per comment",
        description:
            "The most commits one comment can cite for credit; the ones past it earn nothing and the answer says so.",
    },
    {
        key: "tickets.wait_credit.start",
        min: 0,
        max: 86400,
        step: 300,
        scope: "global+project",
        type: "duration",
        default: 3600,
        label: "Wait credit an agent starts with",
        description:
            "Every agent starts each project with this much wait credit, so a new agent can wait on a first build. The credit is spent by step timers (resume_on.timer) and earned by proof of work.",
    },
    {
        key: "tickets.wait_credit.max",
        min: 60,
        max: 86400,
        step: 300,
        scope: "global+project",
        type: "duration",
        default: 7200,
        label: "Most wait credit an agent holds",
        description:
            "A balance never goes over this: what would take it over is not credited, and a balance already over it is cut back. 0 = no cap.",
    },
    {
        key: "tickets.wait_credit.floor",
        min: 0,
        max: 7200,
        step: 60,
        scope: "global+project",
        type: "duration",
        default: 300,
        label: "Wait a step always gets, even without credit",
        description:
            "Short of credit, a step's wait is capped to the balance but never below this, so an agent with no credit does not come back in a loop. It never takes the balance below zero. A step asking 0 (carry on at once) is always granted.",
    },
    {
        key: "tickets.wait_credit.earn.resolved",
        min: 0,
        max: 14400,
        step: 300,
        scope: "global+project",
        type: "duration",
        default: 1800,
        label: "Wait credit earned by a ticket closed resolved, with a commit",
        description:
            "Earned once per ticket by the agent whose resolution was accepted, when it cited a commit on that ticket (commits: [...]) before it closed.",
    },
    {
        key: "tickets.wait_credit.earn.resolved_no_commit",
        min: 0,
        max: 14400,
        step: 300,
        scope: "global+project",
        type: "duration",
        default: 600,
        label: "Wait credit earned by a ticket closed resolved, without a commit",
        description:
            "Earned once per ticket by the agent whose resolution was accepted when it cited no commit on that ticket: a resolution without code is worth less.",
    },
    {
        key: "tickets.wait_credit.earn.wontfix",
        min: 0,
        max: 14400,
        step: 60,
        scope: "global+project",
        type: "duration",
        default: 300,
        label: "Wait credit earned by a ticket closed wontfix",
        description:
            "Earned once per ticket by the agent whose wontfix was accepted.",
    },
    {
        key: "tickets.wait_credit.earn.lines_per_minute",
        min: 1,
        max: 1000,
        step: 5,
        unit: "lines",
        scope: "global+project",
        type: "number",
        default: 20,
        label: "Changed lines per minute of wait credit from a commit",
        description:
            "A commit an agent cites on a reply (commits: [...]) earns one minute per this many changed lines, read in the agent's checkout. Once per commit.",
    },
    {
        key: "tickets.wait_credit.earn.commit_max",
        min: 0,
        max: 14400,
        step: 300,
        scope: "global+project",
        type: "duration",
        default: 1800,
        label: "Most wait credit one commit earns",
        description:
            "The cap on what a single commit earns, however large its diff.",
    },
    {
        key: "tickets.wait_credit.earn.commit_min",
        min: 0,
        max: 3600,
        step: 60,
        scope: "global+project",
        type: "duration",
        default: 120,
        label: "Least wait credit one commit earns",
        description:
            "What a cited commit with at least one changed line earns, however small its diff: a short fix is work too. 0 = only the per-line rate counts.",
    },
    {
        key: "tickets.backlog.claim_protect",
        min: 0,
        max: 86400,
        step: 300,
        scope: "global+project",
        type: "duration",
        default: 3600,
        label: "Minutes a working agent's claim is protected",
        description:
            "How long a claim holds against another agent's claim, counted from its holder's last action on the ticket — working on it keeps the protection alive. Another agent's claim inside that window is refused; past it the ticket can be taken over, and the thread records it. An assignment always wins over a claim. 0 = no protection.",
    },
    {
        key: "tickets.backlog.blocked_multiplier",
        min: 1,
        max: 20,
        step: 0.5,
        unit: "times",
        scope: "global+project",
        type: "number",
        default: 2,
        label: "Backlog cooldown multiplier for blocked tickets",
        description:
            "How much longer a backlog wake keeps a BLOCKED ticket (gated by an open depends_on) out of the wake pool, compared with any other ticket. It must keep surfacing so it is not forgotten, but nothing moves on it between two wakes. 1 = same cooldown as the rest.",
    },
    {
        key: "tickets.backlog.after_step",
        min: 0,
        max: 86400,
        step: 60,
        scope: "global+project",
        type: "duration",
        default: 300,
        label: "Backlog cooldown after a step",
        description:
            "How long a backlog wake keeps a ticket out of the wake pool when its last action is a step (then: continue), instead of the whole cooldown. Short on purpose: the step says there is work to do now, and the pause only lets the queue turn over. 0 = never sink it.",
    },

    // #590 — autopoll FILE entries (migrated from autopoll/config.ts DEFAULTS).
    // `autopoll.enabled` stays special-cased in loadConfig (derived from file
    // presence) and is NOT modelled here — see #590 case #2.
    {
        key: "autopoll.volatile",
        scope: "project",
        type: "boolean",
        default: false,
        sources: ["file"],
        label: "Autopoll: one-shot reminders",
        description:
            "true = notify only when a strictly newer ping arrives (no time-based reminders). false (default) = persistent reminder re-fires after throttle_seconds.",
    },
    {
        key: "autopoll.throttle",
        min: 10,
        max: 86400,
        step: 10,
        scope: "project",
        type: "duration",
        default: 120,
        sources: ["file"],
        label: "Autopoll: reminder cadence",
        description:
            "Reminder cadence in seconds, ignored when volatile=true. 0 = every Stop (spammy). New pings / new open tickets bypass the throttle.",
    },
    {
        key: "autopoll.recent_tickets",
        min: 0,
        max: 20,
        step: 1,
        unit: "count",
        scope: "project",
        type: "number",
        default: 3,
        sources: ["file"],
        label: "Autopoll: recent ticket titles to include",
        description:
            "Up to N recent unread ticket titles in the hook's reason so the agent knows what's waiting before draining. 0 = count only.",
    },
    {
        key: "autopoll.backlog",
        scope: "project",
        type: "boolean",
        default: true,
        sources: ["file"],
        label: "Autopoll: backlog as a trigger",
        description:
            "true (default) = open tickets in scope trigger notifications even without unread pings. false = context-only (display in reason, never the trigger).",
    },
    {
        key: "autopoll.tone",
        scope: "project",
        type: "enum",
        options: ["hint", "directive", "imperative"],
        default: "directive",
        sources: ["file"],
        label: "Autopoll: tone",
        description:
            "hint = polite, easy to ignore. directive (default) = names the action explicitly. imperative = last resort if the agent persists in asking permission patterns.",
    },
];

const BY_KEY = new Map(CONFIG_SCHEMA.map((e) => [e.key, e] as const));

/** #3137, #3138 — the section a setting sits in: its key less the last segment
 *  (`tickets.wait_credit.earn.resolved` → `tickets.wait_credit.earn`). */
export function groupOf(key: string): string {
    const i = key.lastIndexOf(".");
    return i > 0 ? key.slice(0, i) : key;
}

/**
 * #3138 — the keys renamed once, in paths without a unit suffix, and what a
 * value under the old name is worth in the new one (a minute is 60 seconds).
 * An old name is still read, and written, for one version: a file's value
 * converted, `config.set` answering which key it meant.
 */
export const RENAMED_CONFIG_KEYS: Readonly<Record<string, { key: string; factor: number }>> = {
    "tickets.default_priority": { key: "tickets.defaults.priority", factor: 1 },
    "tickets.auto_broadcast_new": { key: "tickets.defaults.broadcast_new", factor: 1 },
    "tickets.summary_until_max": { key: "tickets.rules.summary_max", factor: 1 },
    "tickets.require_then": { key: "tickets.rules.require_then", factor: 1 },
    "tickets.require_commits": { key: "tickets.rules.require_commits", factor: 1 },
    "tickets.step_stale_hours": { key: "tickets.steps.stale", factor: 3600 },
    "tickets.step_hot_minutes": { key: "tickets.steps.hot", factor: 60 },
    "tickets.step_after_max_minutes": { key: "tickets.steps.max_wait", factor: 60 },
    "tickets.wait_credit_enabled": { key: "tickets.wait_credit.enabled", factor: 1 },
    "tickets.wait_credit_refund": { key: "tickets.wait_credit.refund", factor: 1 },
    "tickets.wait_credit_start_minutes": { key: "tickets.wait_credit.start", factor: 60 },
    "tickets.wait_credit_max_minutes": { key: "tickets.wait_credit.max", factor: 60 },
    "tickets.step_min_wait_minutes": { key: "tickets.wait_credit.floor", factor: 60 },
    "tickets.wait_credit_resolved_minutes": { key: "tickets.wait_credit.earn.resolved", factor: 60 },
    "tickets.wait_credit_resolved_no_commit_minutes": { key: "tickets.wait_credit.earn.resolved_no_commit", factor: 60 },
    "tickets.wait_credit_wontfix_minutes": { key: "tickets.wait_credit.earn.wontfix", factor: 60 },
    "tickets.wait_credit_commit_max_age_hours": { key: "tickets.wait_credit.earn.commit_max_age", factor: 3600 },
    "tickets.wait_credit_max_commits_per_comment": { key: "tickets.wait_credit.earn.commits_per_comment", factor: 1 },
    "tickets.wait_credit_commit_lines_per_minute": { key: "tickets.wait_credit.earn.lines_per_minute", factor: 1 },
    "tickets.wait_credit_commit_max_minutes": { key: "tickets.wait_credit.earn.commit_max", factor: 60 },
    "tickets.wait_credit_commit_min_minutes": { key: "tickets.wait_credit.earn.commit_min", factor: 60 },
    "tickets.claim_protect_minutes": { key: "tickets.backlog.claim_protect", factor: 60 },
    "tickets.blocked_cooldown_multiplier": { key: "tickets.backlog.blocked_multiplier", factor: 1 },
    "tickets.sink_then_continue_minutes": { key: "tickets.backlog.after_step", factor: 60 },
    "autopoll.throttle_seconds": { key: "autopoll.throttle", factor: 1 },
    "autopoll.include_recent_tickets": { key: "autopoll.recent_tickets", factor: 1 },
};

/** The entry an old name stands for, with its factor; undefined for a current or unknown key. */
export function renamedFrom(key: string): { entry: ConfigSchemaEntry; old: string; factor: number } | undefined {
    const r = RENAMED_CONFIG_KEYS[key];
    const entry = r ? BY_KEY.get(r.key) : undefined;
    return r && entry ? { entry, old: key, factor: r.factor } : undefined;
}

/** The schema entry for a key, or undefined if the key is unknown. */
export function getSchemaEntry(key: string): ConfigSchemaEntry | undefined {
    return BY_KEY.get(key);
}

/** True when the key may carry a project-layer override. */
export function allowsProjectOverride(entry: ConfigSchemaEntry): boolean {
    return entry.scope === "global+project" || entry.scope === "project";
}

/** True when the key may carry a global-layer override. */
export function allowsGlobalOverride(entry: ConfigSchemaEntry): boolean {
    return entry.scope === "global" || entry.scope === "global+project";
}

/** #590 — sources for an entry, ordered by effective precedence. Defaults to
 *  `["db"]` when `sources` is unset (backwards compat). When both sources are
 *  declared, the entry's `precedence` (or the default `"db"`) is read FIRST. */
export function effectiveSources(entry: ConfigSchemaEntry): readonly ConfigSource[] {
    const sources = entry.sources ?? ["db"];
    if (sources.length < 2) return sources;
    const first = entry.precedence ?? "db";
    return sources[0] === first ? sources : [...sources].reverse();
}

/**
 * Coerce/validate a raw value against a schema entry's type. Returns the typed
 * value, or `null` when invalid (the caller rejects the write). Pure.
 */
export function coerceConfigValue(entry: ConfigSchemaEntry, raw: unknown): ConfigValue | null {
    switch (entry.type) {
        case "boolean":
            if (typeof raw === "boolean") return raw;
            if (raw === "true") return true;
            if (raw === "false") return false;
            return null;
        case "number": {
            const n = typeof raw === "number" ? raw : Number(raw);
            return Number.isFinite(n) ? n : null;
        }
        case "duration":
            return parseDuration(raw);
        case "enum": {
            const s = String(raw);
            return entry.options?.includes(s) ? s : null;
        }
        case "string":
            return typeof raw === "string" ? raw : null;
    }
}
