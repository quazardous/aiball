/**
 * Prompt-template service (#B.232 cpaez7 → simplified #400).
 *
 * Loads wake/state prompt templates from `config/defaults/claude-loop-pings.yaml`
 * (defaults) merged with a per-project override from `.aiball.yaml` → `prompts:`
 * (see `src/autopoll/config.ts`), and renders one by name.
 *
 * **#400 — kept deliberately simple** (david: « le système de prompt devrait
 * être simple, pas du `if` partout »). The `if` david wanted gone is the
 * *conditional ASSEMBLY* in the calling code (`if pingCount` → slot, `if
 * openCount` → slot…) — NOT the **tone** layer nor the **round-robin** (david
 * `b296px`: « le tone et le round robin sont à conserver »). So a slot is one of:
 *   - a plain template string, or
 *   - a list of strings (round-robin random pick for variety), or
 *   - a per-tone bucket map `{ <tone>: string | string[] }` (#400 recadré):
 *     `renderSlot` selects `slot[tone]` (tone = `autopoll.tone`, fallback
 *     `directive`), then round-robins within. Tone is an orthogonal SELECTION
 *     layer applied UNIFORMLY — never a per-placeholder rule the code has to
 *     remember (david `d7zcj5`). Same reason plural stays a flat `(s)` in the
 *     template instead of `_one/_other` slugs.
 * All the conditional *logic* lives in the template via the placeholder grammar
 * below — the calling code is just `renderSlot(map, name, vars, fb, tone)`, no
 * conditional assembly.
 *
 * Placeholder grammar (inspired by shell parameter expansion):
 *   {var}            → the value (empty string when unset/empty)
 *   {var:-default}   → the value, or `default` when unset/empty
 *   {var:+text}      → `text` when var is non-empty, else "" (inline condition)
 *
 * `text`/`default` may themselves contain `{...}` — placeholders resolve from
 * the inside out (the engine iterates until stable).
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/** A per-tone bucket map: each tone (`hint` | `directive` | `imperative`) maps
 *  to a template or a round-robin pool. Selected by `autopoll.tone` (fallback
 *  `directive`). The orthogonal SELECTION layer #400 wrongly dropped (david
 *  b296px). */
export type ToneSlot = Record<string, string | string[]>;

/** A slot: a single template, a round-robin pool, or per-tone buckets. */
export type PromptSlot = string | string[] | ToneSlot;

/** The tone applied when none is given / a bucket map lacks the active tone. */
export const DEFAULT_TONE = "directive";

/** The full `prompts:` block (defaults merged with overrides). */
export type PromptMap = Record<string, PromptSlot>;

/** Values for placeholder substitution — a string/number, or a lazy callback
 *  (so a magic token like `{culture}` can pull a fresh value per render). */
export type RenderVars = Record<string, string | number | (() => string) | null | undefined>;

/** True for a list whose every element is a string. */
function isStringList(v: unknown): v is string[] {
    return Array.isArray(v) && v.every((x): x is string => typeof x === "string");
}

/** Validate a slot: plain string, all-string list, or a per-tone bucket map
 *  whose every value is a string or all-string list. Anything else → null
 *  (the loader drops it, callers fall back to defaults). */
function validateSlot(v: unknown): PromptSlot | null {
    if (typeof v === "string") return v;
    if (isStringList(v)) return v;
    if (v && typeof v === "object" && !Array.isArray(v)) {
        const entries = Object.entries(v as Record<string, unknown>);
        if (entries.length > 0 && entries.every(([, val]) => typeof val === "string" || isStringList(val))) {
            return v as ToneSlot;
        }
    }
    return null;
}

/** Validate + extract a `prompts:` block already parsed from yaml. Empty map
 *  (never null) on shape mismatch so callers can deep-merge without null checks. */
export function loadPromptsFromYamlBlock(block: unknown): PromptMap {
    if (!block || typeof block !== "object") return {};
    const out: PromptMap = {};
    for (const [slot, value] of Object.entries(block as Record<string, unknown>)) {
        const v = validateSlot(value);
        if (v !== null) out[slot] = v;
    }
    return out;
}

/** Load + validate the `prompts:` block from a yaml file path. Empty map on
 *  any failure (missing file, bad yaml). */
export function loadPromptsFromYaml(yamlPath: string): PromptMap {
    try {
        const parsed = parseYaml(readFileSync(yamlPath, "utf8")) as { prompts?: unknown };
        return loadPromptsFromYamlBlock(parsed?.prompts);
    } catch {
        return {};
    }
}

/** Merge `override` over `base` at slot granularity (whole-slot replace). */
export function mergePrompts(base: PromptMap, override: PromptMap): PromptMap {
    return { ...base, ...override };
}

/**
 * #400: render a template string by substituting placeholders:
 *   {var}          → the value (empty when unset/empty)
 *   {var:-default} → the value, or `default` (itself rendered) when empty
 *   {var:+text}    → `text` (rendered) when var is non-empty, else ""
 *
 * A small scanner rather than a regex so a `:-`/`:+` body can contain LITERAL
 * braces — the wake templates embed tool-call syntax like `unread({pings:
 * true})` inside conditionals. `{` that doesn't open a valid placeholder is
 * emitted literally (so `{pings: true}` survives untouched). Bodies are
 * rendered recursively (nesting works); plain values are NOT re-scanned.
 */
export function render(template: string, vars: RenderVars): string {
    const value = (key: string): string => {
        const v = vars[key];
        if (v == null) return "";
        return String(typeof v === "function" ? v() : v);
    };
    let out = "";
    let i = 0;
    while (i < template.length) {
        if (template[i] !== "{") { out += template[i]; i++; continue; }
        const m = /^\{(\w+)(:[-+])?/.exec(template.slice(i));
        if (!m) { out += "{"; i++; continue; }
        const key = m[1];
        const op = m[2]; // ":-" | ":+" | undefined
        let j = i + m[0].length;
        if (!op) {
            // Plain {var}: must be immediately closed, else it's not ours.
            if (template[j] === "}") { out += value(key); i = j + 1; continue; }
            out += "{"; i++; continue;
        }
        // Read the body up to the matching `}` (balanced — literal braces ok).
        let depth = 1;
        let body = "";
        while (j < template.length && depth > 0) {
            const c = template[j];
            if (c === "{") depth++;
            else if (c === "}") { depth--; if (depth === 0) break; }
            body += c;
            j++;
        }
        if (depth !== 0) { out += "{"; i++; continue; } // unbalanced → literal
        const v = value(key);
        out += op === ":-"
            ? (v !== "" ? v : render(body, vars))   // default
            : (v !== "" ? render(body, vars) : ""); // inline condition
        i = j + 1;
    }
    return out;
}

/**
 * Pick a slot from the map by name and render it. Resolution order:
 *   1. Tone layer — if the slot is a per-tone bucket map, narrow to
 *      `slot[tone]` (fallback `slot[DEFAULT_TONE]`). Applied uniformly; not a
 *      per-placeholder rule (david d7zcj5).
 *   2. Round-robin — if the (narrowed) slot is a list, pick a random element.
 *   3. Render — substitute placeholders via the grammar.
 * Returns `fallback` (rendered with the same vars) when the slot is absent,
 * empty, or the bucket can't be resolved. The conditional logic lives in the
 * template; the caller just names the slot + the tone.
 */
export function renderSlot(
    map: PromptMap,
    name: string,
    vars: RenderVars = {},
    fallback = "",
    tone: string = DEFAULT_TONE,
): string {
    let slot = map[name];
    // 1. Tone layer: a bucket map (plain object, not a string/array) → slot[tone].
    if (slot && typeof slot === "object" && !Array.isArray(slot)) {
        slot = (slot as ToneSlot)[tone] ?? (slot as ToneSlot)[DEFAULT_TONE];
    }
    // 2. + 3. Round-robin within the (narrowed) slot, then render.
    let template: string;
    if (typeof slot === "string") template = slot;
    else if (Array.isArray(slot) && slot.length > 0) template = slot[Math.floor(Math.random() * slot.length)];
    else template = fallback;
    return render(template, vars);
}
