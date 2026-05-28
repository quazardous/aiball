/**
 * Ticket-text formatting patterns (#B.235). Same 3-layer override chain as
 * `prompts:` (#B.232): shipped defaults (`config/defaults/claude-loop-pings.yaml`)
 * → global per-user (`~/.config/aiball/config.yaml`) → per-project
 * (`.aiball.yaml`). The frontend's MarkdownView consumes the merged set
 * via `GET /api/config` (the config home) and generates marked extensions dynamically.
 *
 * Merge semantics: by `id`. Defaults from this file are seeded first
 * (always present, never removable — david "garde le fallback code").
 * Each yaml layer may either OVERRIDE a pattern's `canonical`/`href`/`class`
 * by reusing the same id, or ADD a new pattern with a fresh id (e.g.
 * `id: jira` for `JIRA-NNN` links).
 *
 * Regex validation runs at LOAD time (david "devrai etre fait assez tot"):
 * invalid entries are logged to stderr and DROPPED from the merge; the
 * rest proceeds. The frontend never sees a broken regex.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export interface FormattingPattern {
    /** Stable id — entries with the same id across layers override each other. */
    id: string;
    /** ECMAScript regex source. Must compile via `new RegExp(...)`. */
    match: string;
    /**
     * Render template for the visible label. `{1}`, `{2}`, ... reference
     * regex capture groups (1-indexed). `{0}` means "the whole match".
     */
    canonical: string;
    /**
     * Optional href template (same `{N}` placeholders). When present, the
     * canonical label is wrapped in an `<a>`. Captures are URL-encoded
     * before insertion to keep XSS surface narrow.
     */
    href?: string;
    /** Optional CSS class applied to the rendered element. */
    class?: string;
}

/**
 * The in-code defaults — kept as the SOURCE OF TRUTH for the fallback set
 * when the shipped yaml is missing or every entry is rejected. Tracks the
 * shipped defaults verbatim: B-optional match (catches both `#NN` and the
 * legacy `#B.NN`) + bare `#{1}` canonical (#489). The old separator
 * conventions (#B/123, #B-123, #B_123, #B123) still linkify via `[._/-]?`.
 */
export const DEFAULT_FORMATTING_PATTERNS: readonly FormattingPattern[] = [
    {
        id: "ticket",
        // #160 Commit A : revert le lookbehind hack — l'upstream pre-marked
        // pass (`decorateUpstreamPreMarked`) substitue `gh#NNN` par des
        // placeholders Unicode AVANT marked, donc le `#NNN` du ticket
        // pattern ne peut plus collider avec un préfixe provider.
        match: "#[Bb]?[._/-]?(\\d+)\\b",
        canonical: "#{1}",
        href: "/b/{1}",
        class: "ticket-ref",
    },
    {
        id: "comment",
        match: "#[Cc][._/-]?([a-hjkmnp-z2-9]{4,8})\\b",
        canonical: "#C.{1}",
        href: "/b/{1}",
        class: "comment-ref",
    },
    {
        id: "mention",
        // #535 : `>` retiré de la lookbehind (était bloqué pour éviter du nesting
        // dans `<a>@x</a>` mais ça bloquait au passage les mentions juste après
        // `<p>` du markdown rendu — david : « @aiball-win » au début d'un
        // paragraphe n'était jamais wrapé en chip).
        match: "(?<![\\w@\"'/])@([a-zA-Z0-9_-]{2,64})\\b",
        canonical: "@{1}",
        class: "mention",
    },
];

function validatePattern(raw: unknown, source: string): FormattingPattern | null {
    if (!raw || typeof raw !== "object") {
        console.warn(`[formatting] ${source}: pattern rejected — must be a mapping (got ${typeof raw})`);
        return null;
    }
    const p = raw as Record<string, unknown>;
    const id = typeof p.id === "string" ? p.id.trim() : "";
    const match = typeof p.match === "string" ? p.match : "";
    const canonical = typeof p.canonical === "string" ? p.canonical : "";
    if (!id || !match || !canonical) {
        console.warn(
            `[formatting] ${source}: pattern rejected — id/match/canonical all required ` +
                `(id=${JSON.stringify(p.id)}, match=${typeof p.match}, canonical=${typeof p.canonical})`,
        );
        return null;
    }
    try {
        new RegExp(match);
    } catch (e) {
        console.warn(
            `[formatting] ${source}: pattern '${id}' rejected — invalid regex /${match}/: ${(e as Error).message}`,
        );
        return null;
    }
    const out: FormattingPattern = { id, match, canonical };
    if (typeof p.href === "string") out.href = p.href;
    if (typeof p.class === "string") out.class = p.class;
    return out;
}

/**
 * Validate + extract a parsed `formatting:` block. Used by callers that
 * already have the yaml object in hand (e.g. autopoll/config.ts on the
 * per-project load). Returns an empty list (NOT null) on shape mismatch
 * so the merge proceeds without extra null-checks.
 */
export function loadFormattingFromYamlBlock(block: unknown, source = "yaml"): FormattingPattern[] {
    if (!block || typeof block !== "object") return [];
    const arr = (block as { patterns?: unknown }).patterns;
    if (!Array.isArray(arr)) return [];
    const out: FormattingPattern[] = [];
    for (const raw of arr) {
        const v = validatePattern(raw, source);
        if (v) out.push(v);
    }
    return out;
}

/**
 * Load + validate the `formatting:` block from a yaml file path. Thin
 * wrapper around `loadFormattingFromYamlBlock` for callers (like the
 * HTTP endpoint) that only have the path. Returns empty list when the
 * file is missing or unparseable — same silent-degrade behavior as the
 * `prompts:` loader.
 */
export function loadFormattingFromYaml(yamlPath: string): FormattingPattern[] {
    try {
        const raw = readFileSync(yamlPath, "utf8");
        const parsed = parseYaml(raw) as { formatting?: unknown };
        return loadFormattingFromYamlBlock(parsed?.formatting, yamlPath);
    } catch {
        return [];
    }
}

/**
 * Merge layers in priority order (lower index = lower priority). Within
 * a layer, patterns with the same id REPLACE earlier ones at that level
 * (last-wins inside a single yaml). Across layers, higher-priority
 * entries override matching ids while leaving non-matching ones in place.
 */
export function mergeFormatting(
    ...layers: ReadonlyArray<readonly FormattingPattern[]>
): FormattingPattern[] {
    const byId = new Map<string, FormattingPattern>();
    for (const layer of layers) {
        for (const p of layer) {
            byId.set(p.id, p);
        }
    }
    return Array.from(byId.values());
}

/**
 * Resolve the effective patterns from the 3-layer chain. Order matches
 * `prompts:` (#B.232): code defaults → shipped yaml → global → project.
 * Higher in the list overrides earlier ones by id. Code defaults are
 * seeded first so they're always present even when the yaml chain is
 * empty.
 */
export function resolveFormatting(opts: {
    shippedDefaultsPath?: string | null;
    globalConfigPath?: string | null;
    projectConfigPath?: string | null;
}): FormattingPattern[] {
    const shippedYaml = opts.shippedDefaultsPath
        ? loadFormattingFromYaml(opts.shippedDefaultsPath)
        : [];
    const globalYaml = opts.globalConfigPath ? loadFormattingFromYaml(opts.globalConfigPath) : [];
    const projectYaml = opts.projectConfigPath
        ? loadFormattingFromYaml(opts.projectConfigPath)
        : [];
    return mergeFormatting(DEFAULT_FORMATTING_PATTERNS, shippedYaml, globalYaml, projectYaml);
}
