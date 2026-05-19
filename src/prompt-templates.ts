/**
 * Central prompt-template service (#B.232 cpaez7).
 *
 * Loads wake-CTA / state-prompt templates from `skill/claude-loop-pings.yaml`
 * (defaults) and merges any per-project override from `.aiball.yaml` →
 * `prompts:` (see `src/autopoll/config.ts`).
 *
 * Each slot value accepts THREE shapes:
 *   string                 → no variation, identical at every tone
 *   list[string]           → random pick from the pool, identical at every tone
 *   { tone: list[string] } → russian-doll, per-tone pool (random pick within)
 *
 * Tones are aligned with autopoll: `hint | directive | imperative`.
 * A missing tone in an object falls back to `directive` (matches autopoll
 * default; see `src/autopoll/config.ts` DEFAULTS).
 *
 * Why a central service rather than inline parsing: the wake-CTA and the
 * autopoll templates BOTH need the same random-pick + per-tone + override
 * semantics. Sharing here avoids two divergent implementations and lets
 * `.aiball.yaml` host a single `prompts:` block that drives both surfaces.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { AutopollTone } from "./autopoll/config.js";

const DEFAULT_TONE: AutopollTone = "directive";
const VALID_TONES: AutopollTone[] = ["hint", "directive", "imperative"];

/** A single template slot as stored on disk. */
export type PromptSlot =
    | string
    | string[]
    | { [tone in AutopollTone]?: string[] };

/** The full `prompts:` block (defaults merged with overrides). */
export type PromptMap = Record<string, PromptSlot>;

/**
 * Strict shape validator — accepts plain string, all-string list, or an
 * object whose values (under valid tone keys) are all-string lists.
 * Anything else is rejected so a malformed yaml doesn't crash at render
 * time inside a hot wake path; the loader returns null on rejection and
 * callers fall through to whatever defaults were already merged.
 */
function validateSlot(v: unknown): PromptSlot | null {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
        if (v.every((x): x is string => typeof x === "string")) return v;
        return null;
    }
    if (v && typeof v === "object") {
        const obj = v as Record<string, unknown>;
        const out: { [tone in AutopollTone]?: string[] } = {};
        for (const key of Object.keys(obj)) {
            if (!(VALID_TONES as string[]).includes(key)) return null;
            const list = obj[key];
            if (!Array.isArray(list) || !list.every((x): x is string => typeof x === "string")) {
                return null;
            }
            out[key as AutopollTone] = list;
        }
        return out;
    }
    return null;
}

/**
 * Validate + extract a `prompts:` block already parsed from yaml.
 * Used by `src/autopoll/config.ts` which has the raw object in hand —
 * avoids re-reading the file. Returns an empty map (NOT null) on any
 * shape mismatch so callers can deep-merge without extra null-checks.
 */
export function loadPromptsFromYamlBlock(block: unknown): PromptMap {
    if (!block || typeof block !== "object") return {};
    const out: PromptMap = {};
    for (const [slot, value] of Object.entries(block as Record<string, unknown>)) {
        const v = validateSlot(value);
        if (v !== null) out[slot] = v;
    }
    return out;
}

/**
 * Load + validate the `prompts:` block from a yaml file path. Thin
 * wrapper around `loadPromptsFromYamlBlock` for callers (like
 * claude-loop's wake path) that only have the file path. Returns an
 * empty map (NOT null) on any failure so callers can deep-merge without
 * extra null-checks; the rendering layer surfaces the missing-slot case.
 */
export function loadPromptsFromYaml(yamlPath: string): PromptMap {
    try {
        const raw = readFileSync(yamlPath, "utf8");
        const parsed = parseYaml(raw) as { prompts?: unknown };
        return loadPromptsFromYamlBlock(parsed?.prompts);
    } catch {
        return {};
    }
}

/**
 * Merge `override` over `base` at the slot granularity. Whole slots are
 * replaced — we don't deep-merge inside a slot because the russian-doll
 * shape is opt-in per slot (an override of a list-shape slot with an
 * object-shape value is a legitimate user choice we shouldn't second-guess).
 */
export function mergePrompts(base: PromptMap, override: PromptMap): PromptMap {
    const out: PromptMap = { ...base };
    for (const [slot, value] of Object.entries(override)) {
        out[slot] = value;
    }
    return out;
}

/**
 * Substitute `{key}` placeholders in `tpl`. Resolution order per
 * placeholder occurrence:
 *
 *   1. `vars[key]` if present                  → caller-provided values
 *   2. `resolve(key)` if provided and !== undef → lazy / magic tokens
 *   3. the literal `{key}` is left intact       → operator-visible typo
 *
 * The `resolve` callback (#B.232 jdhdxq) lets a caller plug "magic"
 * tokens like `{culture}` — a random pop-culture ping phrase — without
 * pre-injecting them via `vars` at every call site. Called fresh per
 * occurrence so `{culture}` appearing twice in a template can yield
 * two different picks if the resolver is non-idempotent.
 */
function substitute(
    tpl: string,
    vars: Record<string, string | number>,
    resolve?: (key: string) => string | undefined,
): string {
    return tpl.replace(/\{(\w+)\}/g, (m, key: string) => {
        if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key]);
        if (resolve) {
            const v = resolve(key);
            if (v !== undefined) return v;
        }
        return m;
    });
}

function pickRandom<T>(list: readonly T[]): T {
    return list[Math.floor(Math.random() * list.length)];
}

export interface PickOptions {
    /** Variables for `{placeholder}` substitution. */
    vars?: Record<string, string | number>;
    /** Tone bucket (object-shape slots only). Falls back to `directive`. */
    tone?: AutopollTone;
    /**
     * Optional cardinality for CLDR-style two-slug pluralization
     * (#B.232 hd7taf, david: "pour les plural on va utiliser carrément
     * 2 slug de templates différent"). When set, the picker tries
     * `${slot}_one` (when count === 1) or `${slot}_other` (else) BEFORE
     * falling back to plain `${slot}`. Variants support the same 3
     * shapes as a plain slot. Use this instead of a `{plural}` placeholder
     * when singular/plural require different wording — French/English
     * agreement, gendered forms, "no tickets" zero-case, etc.
     */
    count?: number;
    /**
     * Lazy resolver for placeholders not present in `vars` (#B.232 jdhdxq).
     * Called for each `{key}` occurrence the picker can't find in `vars`;
     * return a string to substitute, or `undefined` to leave the
     * placeholder intact. Use for magic tokens like `{culture}` that pull
     * from an external pool (e.g. ping_messages random pick) without
     * forcing every caller to pre-inject them via vars.
     */
    resolve?: (key: string) => string | undefined;
    /** Fallback string when the slot is absent or unrenderable. */
    fallback?: string;
}

/**
 * Resolve a slot entry — checks `_one` / `_other` variants first when a
 * count is provided, then falls back to the plain slot. Returns null
 * when nothing matches; caller uses its fallback.
 */
function resolveEntry(
    map: PromptMap,
    slot: string,
    count: number | undefined,
): PromptSlot | null {
    if (typeof count === "number") {
        const variantKey = count === 1 ? `${slot}_one` : `${slot}_other`;
        const variant = map[variantKey];
        if (variant != null) return variant;
    }
    return map[slot] ?? null;
}

/**
 * Render a slot from the prompt map.
 *
 *   - string slot          → substitute + return
 *   - list[string] slot    → random pick + substitute + return
 *   - object{tone:list}    → tone lookup (or DEFAULT_TONE) → random pick → substitute
 *
 * When `opts.count` is provided, `${slot}_one` / `${slot}_other` variants
 * are consulted FIRST (see `PickOptions.count`), and the plain `${slot}`
 * acts as the no-variant fallback.
 *
 * Returns `opts.fallback ?? ""` when no candidate matches or the matched
 * entry is unrenderable (empty list, missing tone bucket without a
 * `directive` fallback). The hot wake path uses fallbacks like the prior
 * hardcoded wording so a broken yaml degrades gracefully instead of
 * throwing inside the timer.
 */
export function pickPrompt(map: PromptMap, slot: string, opts: PickOptions = {}): string {
    const entry = resolveEntry(map, slot, opts.count);
    const fallback = opts.fallback ?? "";
    if (entry == null) return fallback;
    const vars = opts.vars ?? {};
    const resolve = opts.resolve;
    if (typeof entry === "string") return substitute(entry, vars, resolve);
    if (Array.isArray(entry)) {
        if (entry.length === 0) return fallback;
        return substitute(pickRandom(entry), vars, resolve);
    }
    // Object form
    const tone = opts.tone ?? DEFAULT_TONE;
    const list = entry[tone] ?? entry[DEFAULT_TONE];
    if (!list || list.length === 0) return fallback;
    return substitute(pickRandom(list), vars, resolve);
}
