/**
 * #440 — syntax highlighting for fenced code blocks in rendered markdown.
 *
 * highlight.js CORE + a curated language set (NOT the full `common` bundle) to
 * keep the frontend bundle lean. Registering a language also pulls in its
 * built-in aliases, so `js`/`ts`/`py`/`yml`/`html`/`sh` resolve for free.
 *
 * A fence with a registered language is highlighted; an unknown/absent language
 * falls back to plain escaped text (NO auto-detect — it's costly and guesses
 * wrong on short snippets). The token `<span class="hljs-*">` markup is themed in
 * MarkdownView.vue (light + `.aiball-dark`).
 */
import hljs from "highlight.js/lib/core";

import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// Curated set — the languages that actually show up in aiball tickets. Each
// registration also wires the language's own aliases (e.g. xml → html).
const LANGUAGES = {
    bash, css, diff, ini, javascript, json, markdown,
    python, shell, sql, typescript, xml, yaml,
} as const;
for (const [name, def] of Object.entries(LANGUAGES)) {
    hljs.registerLanguage(name, def as Parameters<typeof hljs.registerLanguage>[1]);
}

/** Local HTML-escape (no import from formatting.ts → avoids a cycle). */
function esc(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
    );
}

/**
 * Highlight `code` for `lang` (the fence's first info-string token). Returns
 * HTML with `hljs-*` token spans for a known language, else the plain text
 * HTML-escaped. The result is always safe markup (hljs escapes; esc escapes).
 */
export function highlightCode(code: string, lang?: string): string {
    const language = (lang ?? "").trim().split(/\s+/)[0].toLowerCase();
    if (language && hljs.getLanguage(language)) {
        try {
            return hljs.highlight(code, { language, ignoreIllegals: true }).value;
        } catch {
            /* malformed grammar input → fall through to plain */
        }
    }
    return esc(code);
}

/** Normalize the fence info-string to the registered language id (or ""). */
export function resolveLang(lang?: string): string {
    const first = (lang ?? "").trim().split(/\s+/)[0].toLowerCase();
    return first && hljs.getLanguage(first) ? first : "";
}
