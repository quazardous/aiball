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

/** Where a key may be overridden. */
export type ConfigScope =
    | "global" // one daemon-wide value; no per-project override
    | "global+project" // a global default that a project may override
    | "project"; // only meaningful per project (no global value)

export type ConfigValueType = "string" | "number" | "boolean" | "enum";

export type ConfigValue = string | number | boolean;

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
    // #449 — DB-source ticket defaults (admin Settings).
    {
        key: "tickets.default_priority",
        scope: "global+project",
        type: "enum",
        options: ["low", "normal", "high", "urgent"],
        default: "normal",
        label: "Default ticket priority",
        description:
            "Priority applied to a new ticket created without an explicit one. Set a global default; a project may override it.",
    },
    {
        key: "tickets.auto_broadcast_new",
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
        key: "tickets.summary_until_max",
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
        key: "tickets.require_then",
        scope: "global+project",
        type: "boolean",
        default: true,
        protected: true,
        label: "Agent comments need then: or handback",
        description:
            "When on, an agent's comment with no then: must set handback (true: it hands the ticket back, false: it keeps it), or it is refused with an explanation and nothing is posted. Humans are exempt.",
    },
    // #2308 — a step (`then: continue`) keeps a ticket in its author's pool; one
    // that nothing follows is flagged in the inbox after this many hours.
    {
        key: "tickets.step_stale_hours",
        scope: "global+project",
        type: "number",
        default: 24,
        label: "Stalled step after (hours)",
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
    {
        key: "tickets.claim_protect_minutes",
        scope: "global+project",
        type: "number",
        default: 30,
        label: "Minutes a working agent's claim is protected",
        description:
            "How long a claim holds against another agent's claim, counted from its holder's last action on the ticket — working on it keeps the protection alive. Another agent's claim inside that window is refused; past it the ticket can be taken over, and the thread records it. An assignment always wins over a claim. 0 = no protection.",
    },
    {
        key: "tickets.blocked_cooldown_multiplier",
        scope: "global+project",
        type: "number",
        default: 2,
        label: "Backlog cooldown multiplier for blocked tickets",
        description:
            "How much longer a backlog wake keeps a BLOCKED ticket (gated by an open depends_on) out of the wake pool, compared with any other ticket. It must keep surfacing so it is not forgotten, but nothing moves on it between two wakes. 1 = same cooldown as the rest.",
    },
    {
        key: "tickets.sink_then_continue_minutes",
        scope: "global+project",
        type: "number",
        default: 5,
        label: "Backlog cooldown after a step (minutes)",
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
        key: "autopoll.throttle_seconds",
        scope: "project",
        type: "number",
        default: 120,
        sources: ["file"],
        label: "Autopoll: reminder cadence (s)",
        description:
            "Reminder cadence in seconds, ignored when volatile=true. 0 = every Stop (spammy). New pings / new open tickets bypass the throttle.",
    },
    {
        key: "autopoll.include_recent_tickets",
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
        case "enum": {
            const s = String(raw);
            return entry.options?.includes(s) ? s : null;
        }
        case "string":
            return typeof raw === "string" ? raw : null;
    }
}
