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
}

/**
 * The seed registry. Add a key here and it's automatically available to the
 * layered read, the REST surface, and (next slice) the generic settings UI —
 * no per-key router/panel wiring. `tickets.default_priority` is wired through to
 * ticket creation as the first real consumer (proof of the end-to-end path);
 * the others are declared and consumed as each gets wired.
 */
export const CONFIG_SCHEMA: readonly ConfigSchemaEntry[] = [
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
