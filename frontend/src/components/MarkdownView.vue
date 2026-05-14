<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { bus } from "../lib/bus";
import { extractQuestions } from "../lib/questions";

/**
 * `messageId` + `questionsClickable` opt the body into the #B.104
 * Q&A flow: each GFM `- [ ]` becomes a clickable handle that emits
 * `composer.add-answer` on the bus. The composer subscribes, appends
 * a quote of the question text, and tracks the (messageId, questionId)
 * pair so the eventual submit toggles the checkbox via the API.
 */
const props = defineProps<{
    source: string | null | undefined;
    messageId?: number;
    questionsClickable?: boolean;
}>();

marked.setOptions({
    gfm: true,
    breaks: true,
});

interface MsgRefToken extends Tokens.Generic {
    type: "msgRef";
    raw: string;
    kind: "ticket" | "comment";
    label: string;
    /** Backend lookup key — integer for tickets, string hashid for comments. */
    ref: string;
}

// Linkify cross-message refs in body text → /b/<ref>. The API resolves
// either an integer (ticket id or legacy comment id) or a comment hashid;
// in all three cases the route lands on the parent thread.
//
// Canonical render uses a **dot** between the sigil and the id/hashid
// (`#B.123`, `#C.xk7q3a`) for readability. Authors can type any of these
// equivalent separator characters and they all parse the same way:
//   - `#B.123` / `#C.xk7q3a` (canonical, dot)
//   - `#B/123` / `#C/xk7q3a` (slash)
//   - `#B_123` / `#C_xk7q3a` (underscore)
//   - `#B-123` / `#C-xk7q3a` (dash)
//   - `#B123`  / `#Cxk7q3a`  (legacy, no separator)
//
// The bare `#123` form is NOT matched: it produced too many false
// positives in prose ("item #9", "step #2") per #B.62 follow-up.
// Authors must type the sigil letter to get a linkified ref.
//
// Matching is case-insensitive on the sigil letter only. Runs as an inline
// marked extension so codespans, fenced blocks, and existing markdown
// links are tokenized first. The trailing \b prevents matches inside hex
// colors (#abc, #123abc).
const HASHID_CHARS = "a-hjkmnp-z2-9"; // matches src/db.ts HASHID_ALPHABET
const SEP = "[._/-]?"; // optional separator between sigil and id/hashid
marked.use({
    extensions: [
        {
            name: "msgRef",
            level: "inline",
            start(src: string) {
                const m = src.match(new RegExp(`#(?:[bBcC])?[._/-]?[\\d${HASHID_CHARS}]`, "i"));
                return m?.index;
            },
            tokenizer(src: string): MsgRefToken | undefined {
                // Canonical comment hashid first: #C[sep]?<4-8 chars from
                // the hashid alphabet> (case-insensitive).
                const hashMatch = new RegExp(
                    `^#[Cc]${SEP}([${HASHID_CHARS}]{4,8})\\b`,
                    "i",
                ).exec(src);
                if (hashMatch) {
                    const hash = hashMatch[1].toLowerCase();
                    return {
                        type: "msgRef",
                        raw: hashMatch[0],
                        kind: "comment",
                        label: `#C.${hash}`,
                        ref: hash,
                    };
                }
                // Numeric forms — letter REQUIRED (bare `#NN` no longer
                // linkifies per #B.62 follow-up: too many prose false
                // positives like "item #9").
                const numMatch = new RegExp(`^#([bBcC])${SEP}(\\d+)\\b`).exec(src);
                if (!numMatch) return undefined;
                const prefix = numMatch[1].toUpperCase();
                const kind: "ticket" | "comment" = prefix === "C" ? "comment" : "ticket";
                const letter = kind === "comment" ? "C" : "B";
                return {
                    type: "msgRef",
                    raw: numMatch[0],
                    kind,
                    label: `#${letter}.${numMatch[2]}`,
                    ref: numMatch[2],
                };
            },
            renderer(token) {
                const t = token as MsgRefToken;
                const cls = t.kind === "ticket" ? "ticket-ref" : "comment-ref";
                return `<a href="/b/${t.ref}" class="${cls}">${t.label}</a>`;
            },
        },
    ],
});

// Patterns to linkify `#B.NNN` / `#C.<hashid>` refs that ended up inside
// a `<code>` span because the author wrapped them in backticks. The
// inline marked extension above intentionally skips codespans (per
// Markdown semantics, backticks mean "literal, don't interpret") — but
// in practice writers reach for backticks to *style* a ref while still
// wanting the link. Compromise: keep the codespan styling and wrap it
// in an anchor so the eye sees `#B.276` and the cursor opens the
// thread. Outside-of-code refs are still handled by the marked
// extension as before.
const TICKET_CODE_RE = /<code>#([Bb])([._/-]?)(\d+)<\/code>/g;
const COMMENT_CODE_RE = /<code>#([Cc])([._/-]?)([a-hjkmnp-z2-9]{4,8})<\/code>/gi;
// `@<name>` mention highlighter (per #B.71). Scans the SANITIZED html
// (after marked + DOMPurify) so HTML tags can't be smuggled through.
// Won't match inside <code>…</code> spans because those contain literal
// `&lt;` / `&gt;` already and the lookbehind here requires a non-word
// non-`@` char or start-of-string just before the `@`. Anchor tags
// (<a href="…">) typically have `=` before so they're skipped too.
//
// The backend fires the actual ping fan-out (forcing delivery to the
// mentioned consumer or to the project's owners + followers); this UI
// styling is purely visual so the author can see WHICH mentions will
// trigger pings.
const MENTION_RE = /(^|[^\w@>"'\/])@([a-zA-Z0-9_-]{2,64})\b/g;

const html = computed(() => {
    const src = props.source ?? "";
    if (!src) return "";
    const raw = marked.parse(src, { async: false }) as string;
    const sanitized = DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: [
            "h1", "h2", "h3", "h4", "h5", "h6",
            "p", "br", "hr",
            "strong", "em", "del", "code", "pre",
            "blockquote",
            "ul", "ol", "li",
            "a", "img",
            "table", "thead", "tbody", "tr", "th", "td",
            "input", // gfm checkboxes
        ],
        ALLOWED_ATTR: ["href", "title", "alt", "src", "type", "checked", "disabled", "class"],
        ALLOW_DATA_ATTR: false,
    });
    return sanitized
        .replace(TICKET_CODE_RE, (_, _letter, sep, id) =>
            `<a class="ticket-ref ticket-ref--code" href="/b/${id}"><code>#B${sep}${id}</code></a>`,
        )
        .replace(COMMENT_CODE_RE, (_, _letter, sep, hash) => {
            const h = hash.toLowerCase();
            return `<a class="comment-ref comment-ref--code" href="/b/${h}"><code>#C${sep}${hash}</code></a>`;
        })
        .replace(MENTION_RE, (_, lead, name) =>
            `${lead}<span class="mention" title="Mention — fan-out ping fires on insertion.">@${name}</span>`,
        );
});

// Intercept clicks on internal links (any /b/N, /rules, /tags, /projects, etc.)
// so the SPA router handles them instead of triggering a full reload.
async function onClick(ev: MouseEvent) {
    if (ev.defaultPrevented || ev.button !== 0) return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return; // modifier → let browser do its thing
    const target = (ev.target as HTMLElement | null)?.closest("a");
    if (!target) return;
    const href = target.getAttribute("href");
    if (!href || !href.startsWith("/")) return;
    ev.preventDefault();

    // /b/<hashid> needs server-side resolution to the parent ticket id
    // because the SPA router stores openTicketId as integer. We let the
    // backend do the lookup, then redirect to the canonical /b/<intId>
    // (with #cseq-N hash if a comment was the original target — future
    // improvement; the focus_message_id is already returned by the API).
    const match = /^\/b\/([^/?#]+)(.*)$/.exec(href);
    if (match && !/^\d+$/.test(match[1])) {
        try {
            // #B.94: hashid → numeric id resolution lives under the
            // bearer-auth middleware. Send the stored token; the SPA
            // shell handles 401 globally via setUnauthorizedHandler.
            const tok = localStorage.getItem("aiball.token");
            const headers: Record<string, string> = {};
            if (tok) headers["authorization"] = `Bearer ${tok}`;
            const res = await fetch(
                `/api/tickets/${encodeURIComponent(match[1])}`,
                { headers },
            );
            if (res.ok) {
                const data = await res.json();
                if (data?.ticket?.id) {
                    history.pushState({}, "", `/b/${data.ticket.id}${match[2]}`);
                    window.dispatchEvent(new PopStateEvent("popstate"));
                    return;
                }
            }
        } catch {
            /* fall through to default navigation */
        }
    }

    history.pushState({}, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
}

// #B.104: after every re-render, scan rendered checkboxes and wire
// the click → "ask the composer to quote this question" flow. We
// pair the Nth DOM checkbox with the Nth task-list line in the
// source body to recover the question id from its `<!-- q:xxx -->`
// marker. DOMPurify strips the HTML comment, so the rendered DOM
// has no way to carry the id directly — the source string is the
// source of truth.
const rootRef = ref<HTMLDivElement | null>(null);

async function wireQuestionClicks() {
    await nextTick();
    const root = rootRef.value;
    if (!root) return;
    const inputs = Array.from(root.querySelectorAll('input[type="checkbox"]'));
    if (inputs.length === 0) return;
    const questions = extractQuestions(props.source ?? "");
    const clickable = props.questionsClickable === true && props.messageId !== undefined;
    inputs.forEach((el, i) => {
        const input = el as HTMLInputElement;
        const q = questions[i];
        if (!q) return;
        input.dataset.aiballQid = q.id;
        // Enable interaction only when explicitly opted in. Toggles
        // are NEVER persisted from a raw click — the composer flow
        // owns the write-back. We prevent the default checkbox toggle
        // so the visual state stays in sync with the source body.
        if (clickable && q.status === "open") {
            input.removeAttribute("disabled");
            input.addEventListener("click", onQuestionClick, { once: true });
            input.classList.add("aiball-q-clickable");
        }
    });
}

function onQuestionClick(ev: Event) {
    const input = ev.target as HTMLInputElement;
    ev.preventDefault();
    // Don't actually flip the checkbox — let the round-trip handle it.
    input.checked = false;
    const qid = input.dataset.aiballQid;
    if (!qid || props.messageId === undefined) return;
    const questions = extractQuestions(props.source ?? "");
    const q = questions.find((x) => x.id === qid);
    if (!q) return;
    bus.emit("composer.add-answer", {
        messageId: props.messageId,
        questionId: q.id,
        questionText: q.text,
    });
}

watch(html, () => { void wireQuestionClicks(); }, { flush: "post" });
</script>

<template>
    <div ref="rootRef" class="md-body" @click="onClick" v-html="html" />
</template>

<style>
.md-body {
    line-height: 1.5;
    word-wrap: break-word;
}
.md-body :first-child { margin-top: 0; }
.md-body :last-child { margin-bottom: 0; }
.md-body h1, .md-body h2, .md-body h3, .md-body h4, .md-body h5, .md-body h6 {
    margin: 0.6em 0 0.3em;
    line-height: 1.25;
    font-weight: 600;
}
.md-body h1 { font-size: 1.4em; }
.md-body h2 { font-size: 1.25em; }
.md-body h3 { font-size: 1.1em; }
.md-body p { margin: 0.4em 0; }
.md-body code {
    background: var(--p-surface-100);
    padding: 0.1em 0.35em;
    border-radius: 0.2rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
}
.aiball-dark .md-body code { background: var(--p-surface-800); }
.md-body pre {
    background: var(--p-surface-100);
    padding: 0.6em 0.8em;
    border-radius: 0.3rem;
    overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
}
.aiball-dark .md-body pre { background: var(--p-surface-800); }
.md-body pre > code {
    background: transparent;
    padding: 0;
}
.md-body blockquote {
    border-left: 3px solid var(--p-content-border-color);
    padding-left: 0.8em;
    color: var(--p-text-muted-color);
    margin: 0.4em 0;
}
.md-body ul, .md-body ol { padding-left: 1.4em; margin: 0.4em 0; }
.md-body table { border-collapse: collapse; }
.md-body th, .md-body td {
    border: 1px solid var(--p-content-border-color);
    padding: 0.3em 0.6em;
}
.md-body a { color: var(--p-primary-color); }
.md-body img { max-width: 100%; }
.md-body hr {
    border: none;
    border-top: 1px solid var(--p-content-border-color);
    margin: 0.8em 0;
}
/* `@name` mentions (per #B.71). Visual cue so the author sees what
 * triggers a forced ping. No href — clicks are inert. */
.md-body .mention {
    display: inline-block;
    padding: 0.05rem 0.35rem;
    border-radius: 0.25rem;
    background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
    color: var(--p-primary-color);
    font-weight: 500;
    font-size: 0.92em;
}
</style>
