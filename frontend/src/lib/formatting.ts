/**
 * Data-driven ticket-text linkifier (#B.235). Replaces the patterns that
 * MarkdownView.vue used to hardcode: they now come from the backend's
 * merged config (`GET /api/config` → `formatting[]`, the yaml 3-layer
 * chain). The in-code DEFAULTS below mirror the backend fallback so the
 * first render works synchronously — `loadFormatting()` then fetches the
 * effective set and swaps it in reactively (same "defaults always present"
 * contract as `src/formatting.ts` server-side).
 *
 * A pattern is `{ id, match, canonical, href?, class? }`:
 *   - `match`     ECMAScript regex source (no flags; `[Bb]`/`[Cc]` carry
 *                 their own case-insensitivity).
 *   - `canonical` visible label template; `{1}`,`{2}` = capture groups,
 *                 `{0}` = whole match.
 *   - `href`      optional link target template (same `{N}`, URL-encoded).
 *                 href patterns become inline `<a>` links; href-less ones
 *                 (e.g. `mention`) render as `<span>`.
 *   - `class`     CSS class on the rendered element.
 */
import { Marked, type Tokens } from "marked";
import { ref } from "vue";

export interface FormattingPattern {
    id: string;
    match: string;
    canonical: string;
    href?: string;
    class?: string;
}

// Mirrors src/formatting.ts DEFAULT_FORMATTING_PATTERNS (the pre-#B.235
// hardcoded MarkdownView behavior): letter REQUIRED for numeric ticket
// refs, dotted canonical. The yaml chain overrides these by id.
const DEFAULTS: FormattingPattern[] = [
    { id: "ticket", match: "#[Bb][._/-]?(\\d+)\\b", canonical: "#B.{1}", href: "/b/{1}", class: "ticket-ref" },
    { id: "comment", match: "#[Cc][._/-]?([a-hjkmnp-z2-9]{4,8})\\b", canonical: "#C.{1}", href: "/b/{1}", class: "comment-ref" },
    { id: "mention", match: "(?<![\\w@>\"'/])@([a-zA-Z0-9_-]{2,64})\\b", canonical: "@{1}", class: "mention" },
];

/** HTML-escape for safe insertion into text or double-quoted attributes. */
function esc(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
    );
}

/** Expand `{N}` placeholders from a regex match. `{0}` = whole match. */
function subst(tpl: string, m: readonly string[], encode = false): string {
    return tpl.replace(/\{(\d+)\}/g, (_, n) => {
        const v = m[Number(n)] ?? "";
        return encode ? encodeURIComponent(v) : v;
    });
}

/**
 * Build an isolated `Marked` instance whose inline extensions linkify the
 * href-bearing patterns. Href-less patterns are applied post-sanitize (see
 * `applyPostSanitize`) since they need to scan the rendered+sanitized html.
 */
export function buildMarked(pats: FormattingPattern[]): Marked {
    const inst = new Marked({ gfm: true, breaks: true });
    const exts = pats
        .filter((p) => p.href)
        .map((p) => {
            const name = `fmt_${p.id}`;
            const anchored = new RegExp(`^(?:${p.match})`);
            const search = new RegExp(p.match);
            return {
                name,
                level: "inline" as const,
                start(src: string): number | undefined {
                    return src.match(search)?.index;
                },
                tokenizer(src: string): Tokens.Generic | undefined {
                    const mm = anchored.exec(src);
                    if (!mm) return undefined;
                    return {
                        type: name,
                        raw: mm[0],
                        label: esc(subst(p.canonical, mm)),
                        href: esc(subst(p.href as string, mm, true)),
                        cls: p.class ? esc(p.class) : "",
                    } as Tokens.Generic;
                },
                renderer(tok: Tokens.Generic): string {
                    const t = tok as Tokens.Generic & { label: string; href: string; cls: string };
                    const cls = t.cls ? ` class="${t.cls}"` : "";
                    return `<a href="${t.href}"${cls}>${t.label}</a>`;
                },
            };
        });
    if (exts.length) inst.use({ extensions: exts });
    return inst;
}

/**
 * Post-sanitize pass over the rendered html:
 *   - href patterns: relinkify refs the author wrapped in backticks
 *     (`<code>#B.276</code>` → `<a><code>#B.276</code></a>`). The inline
 *     extension skips codespans by Markdown rule, so we re-add the link
 *     while keeping the code styling — matches pre-#B.235 behavior.
 *   - href-less patterns (mention): wrap in a `<span class>`.
 * Runs AFTER DOMPurify, so every inserted value is HTML-escaped here.
 */
export function applyPostSanitize(html: string, pats: FormattingPattern[]): string {
    let out = html;
    for (const p of pats) {
        if (p.href) {
            const codeRe = new RegExp(`<code>(${p.match})</code>`, "g");
            out = out.replace(codeRe, (_full: string, ref: string, ...rest: unknown[]) => {
                const groups = rest.slice(0, rest.length - 2) as string[];
                const m = [ref, ...groups];
                const href = esc(subst(p.href as string, m, true));
                const cls = p.class ? ` class="${esc(p.class)} ${esc(p.class)}--code"` : "";
                return `<a${cls} href="${href}"><code>${esc(ref)}</code></a>`;
            });
        } else {
            const re = new RegExp(p.match, "g");
            out = out.replace(re, (full: string, ...rest: unknown[]) => {
                const groups = rest.slice(0, rest.length - 2) as string[];
                const m = [full, ...groups];
                const label = esc(subst(p.canonical, m));
                const cls = p.class ? ` class="${esc(p.class)}"` : "";
                const title = p.id === "mention"
                    ? ' title="Mention — fan-out ping fires on insertion."'
                    : "";
                return `<span${cls}${title}>${label}</span>`;
            });
        }
    }
    return out;
}

/** Effective patterns + the Marked instance built from them (reactive). */
export const patterns = ref<FormattingPattern[]>(DEFAULTS);
export const markedInstance = ref<Marked>(buildMarked(DEFAULTS));

/**
 * Format a bare ticket id as a ticket reference using the configured
 * `ticket` pattern's canonical template (#272). Markdown bodies already
 * render `#B.NNN` / `#NNN` through this config (e.g. canonical `#{1}`
 * drops the legacy `B.`); UI chrome that prints a ticket ref outside a
 * body — relation chips, the change-kind menu, relation timeline rows —
 * used to hardcode `#B.${id}` and so ignored the project's format. Route
 * those through here instead.
 *
 * Reads the reactive `patterns` ref, so callers used inside a template
 * expression re-render when the config loads. Falls back to the dotted
 * `#B.${id}` legacy form if the `ticket` pattern is somehow absent.
 */
export function formatTicketRef(id: number | string): string {
    const p = patterns.value.find((x) => x.id === "ticket");
    if (!p) return `#B.${id}`;
    // {1} = the numeric id (the ticket pattern's capture group); {0} = a
    // plausible whole match for canonicals that reference it.
    return subst(p.canonical, [`#${id}`, String(id)]);
}

/**
 * Fetch the effective config from the backend and swap in the merged
 * patterns. Silent no-op on failure — the in-code DEFAULTS stay live, so
 * linkifying never breaks just because the endpoint hiccuped.
 */
export async function loadFormatting(): Promise<void> {
    try {
        const tok = localStorage.getItem("aiball.token");
        const headers: Record<string, string> = {};
        if (tok) headers["authorization"] = `Bearer ${tok}`;
        const res = await fetch("/api/config", { headers });
        if (!res.ok) return;
        const data = await res.json();
        const next = data?.formatting;
        if (Array.isArray(next) && next.length > 0) {
            patterns.value = next as FormattingPattern[];
            markedInstance.value = buildMarked(patterns.value);
        }
    } catch {
        /* keep DEFAULTS */
    }
}

// Kick off the one-shot fetch when this module is first imported. ES module
// singletons guarantee this runs exactly once regardless of how many
// components import it.
void loadFormatting();
