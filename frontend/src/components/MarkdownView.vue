<script setup lang="ts">
import { computed } from "vue";
import { marked, type Tokens } from "marked";
import DOMPurify from "dompurify";

const props = defineProps<{ source: string | null | undefined }>();

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
// Accepted source forms:
//   - `#B123`            → ticket (canonical numeric, "B" for ball/bug).
//   - `#C<hashid>`       → comment (canonical, 6-char base32, e.g. #Cxk7q3a).
//   - `#C123`            → legacy numeric comment ref, still accepted for
//                          old posts written before the hashid switch.
//   - `#123`             → ticket (legacy, equivalent to `#B123`).
//
// Matching is case-insensitive on the sigil letter only. Runs as an inline
// marked extension so codespans, fenced blocks, and existing markdown
// links are tokenized first. The trailing \b prevents matches inside hex
// colors (#abc, #123abc).
const HASHID_CHARS = "a-hjkmnp-z2-9"; // matches src/db.ts HASHID_ALPHABET
marked.use({
    extensions: [
        {
            name: "msgRef",
            level: "inline",
            start(src: string) {
                const m = src.match(new RegExp(`#(?:[bBcC])?[\\d${HASHID_CHARS}]`, "i"));
                return m?.index;
            },
            tokenizer(src: string): MsgRefToken | undefined {
                // Canonical comment hashid first: #C followed by 4-8 chars
                // from the hashid alphabet (case-insensitive).
                const hashMatch = new RegExp(
                    `^#[Cc]([${HASHID_CHARS}]{4,8})\\b`,
                    "i",
                ).exec(src);
                if (hashMatch) {
                    const hash = hashMatch[1].toLowerCase();
                    return {
                        type: "msgRef",
                        raw: hashMatch[0],
                        kind: "comment",
                        label: `#C${hash}`,
                        ref: hash,
                    };
                }
                // Numeric forms (ticket or legacy comment).
                const numMatch = /^#([bBcC])?(\d+)\b/.exec(src);
                if (!numMatch) return undefined;
                const prefix = (numMatch[1] ?? "").toUpperCase();
                const kind: "ticket" | "comment" = prefix === "C" ? "comment" : "ticket";
                const letter = kind === "comment" ? "C" : "B";
                return {
                    type: "msgRef",
                    raw: numMatch[0],
                    kind,
                    label: `#${letter}${numMatch[2]}`,
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

const html = computed(() => {
    const src = props.source ?? "";
    if (!src) return "";
    const raw = marked.parse(src, { async: false }) as string;
    return DOMPurify.sanitize(raw, {
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
            const res = await fetch(`/api/tickets/${encodeURIComponent(match[1])}`);
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
</script>

<template>
    <div class="md-body" @click="onClick" v-html="html" />
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
</style>
