<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { bus } from "../lib/bus";
import { promoteTrigger } from "../lib/prefs";
import { extractQuestions } from "../lib/questions";
import { markedInstance } from "../lib/formatting";
import { BUILT_IN_BODY_DECORATORS, renderBody } from "../lib/body-decorators";
import { wireAttachmentCards } from "../lib/attachment-card";

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
    /**
     * #B.123 follow-up: id of the ticket this body lives under, when
     * known. Used to suppress the "promote to typed relation" right-
     * click intercept on self-references (a ticket can't link to
     * itself; suppressing keeps the browser's native context menu
     * available on those links). When undefined, all ticket-refs
     * route to the promote popup as before.
     */
    selfTicketId?: number;
    /**
     * #160 Phase 1 — project name this body lives under. Used to resolve
     * upstream refs like `gh#NNN` via the project's `upstream` bindings
     * (cf. `applyUpstreamRefs`). When undefined or the project has no
     * binding, the refs stay as plain text (graceful degrade).
     */
    project?: string | null;
}>();

// Linkify cross-message refs (`#B.123`, `#C.<hashid>`) and `@mentions`. Le
// pipeline body (preMarked → marked → sanitize → postSanitize → restore) vit
// dans `../lib/body-decorators` (#160 Commit B) — chaque feature qui veut
// décorer un body (upstream chips, mention spans, futurs emoji-shortcodes,
// etc.) s'enregistre dans `BUILT_IN_BODY_DECORATORS` plutôt que de câbler son
// passe ad-hoc ici. `markedInstance` reste réactif (rebuild quand la config
// formatting change) ; les décorateurs lisent leurs propres refs au render.
const html = computed(() => renderBody(
    props.source ?? "",
    markedInstance.value,
    { project: props.project ?? null },
    BUILT_IN_BODY_DECORATORS,
));

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

    // #361 : sur tactile, le tap émule un mouseover qui arme le timer
    // hover-promote ; on le désarme avant de naviguer pour que le
    // popover n'apparaisse pas APRÈS la redirection SPA.
    if (hoverTimer !== null) {
        window.clearTimeout(hoverTimer);
        hoverTimer = null;
    }

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

// #B.123 phase B.5: right-click on a `.ticket-ref` link inside a
// rendered body offers to promote the inline reference to a typed
// relation. Suppresses the native browser context menu only when the
// click landed on a ticket-ref; emits a bus event ThreadView listens
// to, anchoring its relation-menu Popover at the click coords. Plain
// right-click anywhere else passes through (we don't hijack the
// browser menu globally).
// Helper: extract a target ticket id from a `.ticket-ref` link, or
// null when the click/hover landed elsewhere / on a self-reference.
function ticketRefFromEvent(ev: Event): { ticketId: number; target: HTMLElement } | null {
    const el = (ev.target as HTMLElement | null)?.closest("a.ticket-ref");
    if (!el) return null;
    const href = el.getAttribute("href") ?? "";
    const match = /^\/b\/(\d+)/.exec(href);
    if (!match) return null;
    const ticketId = Number(match[1]);
    if (!Number.isFinite(ticketId) || ticketId <= 0) return null;
    if (props.selfTicketId !== undefined && ticketId === props.selfTicketId) return null;
    return { ticketId, target: el as HTMLElement };
}

function onContextMenu(ev: MouseEvent) {
    // Only handles right-click when the user has chosen contextmenu
    // trigger mode; hover mode lets the browser's native menu show on
    // right-click of refs (since clicking is no longer the trigger).
    if (promoteTrigger.value !== "contextmenu") return;
    const hit = ticketRefFromEvent(ev);
    if (!hit) return;
    ev.preventDefault();
    bus.emit("ticket-ref.promote", { ticket_id: hit.ticketId, event: ev, target: hit.target });
}

let hoverTimer: number | null = null;
function onMouseOver(ev: MouseEvent) {
    if (promoteTrigger.value !== "hover") return;
    // #361 : pas de hover-promote sur les appareils sans survol réel
    // (tactile). Là le tap émule un mouseover qui ouvrirait le popover
    // juste après la navigation, le laissant collé à l'écran.
    if (window.matchMedia?.("(hover: none)").matches) return;
    const hit = ticketRefFromEvent(ev);
    if (!hit) return;
    // Small delay so brushing past links doesn't trigger the popover.
    if (hoverTimer !== null) window.clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(() => {
        hoverTimer = null;
        bus.emit("ticket-ref.promote", { ticket_id: hit.ticketId, event: ev, target: hit.target });
    }, 350);
}
function onMouseOut(ev: MouseEvent) {
    if (promoteTrigger.value !== "hover") return;
    const hit = ticketRefFromEvent(ev);
    if (!hit) return;
    if (hoverTimer !== null) {
        window.clearTimeout(hoverTimer);
        hoverTimer = null;
    }
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

// #556: copy-button overlay on every rendered `<pre>` (fenced code block).
// Comme `wireQuestionClicks`, on agit en post-render DOM (plutôt qu'en
// modifiant le renderer marked) parce que le bouton vit en dehors du flow
// markdown : il est purement chrome UI, n'a pas à survivre à un copy/paste
// du body lui-même (textContent du `<code>` reste propre).
async function wireCopyButtons() {
    await nextTick();
    const root = rootRef.value;
    if (!root) return;
    const pres = root.querySelectorAll("pre");
    for (const pre of pres) {
        if (pre.querySelector(":scope > .md-copy-btn")) continue; // idempotent
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "md-copy-btn";
        btn.setAttribute("aria-label", "Copy code");
        btn.textContent = "Copy";
        btn.addEventListener("click", onCopyClick);
        pre.appendChild(btn);
    }
}

async function onCopyClick(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const btn = ev.currentTarget as HTMLButtonElement;
    const pre = btn.parentElement as HTMLElement | null;
    const code = pre?.querySelector("code");
    if (!code) return;
    const text = code.textContent ?? "";
    try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "Copied";
        btn.classList.add("is-copied");
    } catch {
        btn.textContent = "Failed";
        btn.classList.add("is-failed");
    }
    window.setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("is-copied", "is-failed");
    }, 1500);
}

// #723 — after every render, walk the DOM for `/uploads/…` links and
// swap each one for an AttachmentCard (DL button + collapsible inline
// preview when previewable). Same post-render style as wireCopyButtons.
function wireAttachments() {
    const root = rootRef.value;
    if (!root) return;
    wireAttachmentCards(root, {
        renderMarkdown: (md) => markedInstance.value.parse(md, { async: false }) as string,
    });
}

// `immediate: true` so the very first render also wires clicks —
// `watch` without it only fires on subsequent changes, which means a
// freshly mounted MarkdownView would leave its checkboxes inert until
// the source changes again.
watch(html, () => {
    void wireQuestionClicks();
    void wireCopyButtons();
    wireAttachments();
}, { flush: "post", immediate: true });
</script>

<template>
    <div
        ref="rootRef"
        class="md-body"
        @click="onClick"
        @contextmenu="onContextMenu"
        @mouseover="onMouseOver"
        @mouseout="onMouseOut"
        v-html="html"
    />
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
.md-body pre {
    position: relative; /* #556: anchor for .md-copy-btn overlay */
    background: var(--p-surface-100);
    padding: 0.6em 0.8em;
    border-radius: 0.3rem;
    overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
}
/* #556: copy-to-clipboard button, top-right of each fenced code block.
   Toujours visible (un code block invite à l'action). Discret par défaut
   (background semi-transparent + faible opacité), franc au hover. */
.md-body pre > .md-copy-btn {
    position: absolute;
    top: 0.3em;
    right: 0.3em;
    padding: 0.15em 0.5em;
    font: inherit;
    font-size: 0.85em;
    line-height: 1.2;
    background: var(--p-surface-0, #fff);
    color: var(--p-text-muted-color);
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.25rem;
    cursor: pointer;
    opacity: 0.55;
    transition: opacity 0.15s, color 0.15s, border-color 0.15s;
}
.md-body pre > .md-copy-btn:hover,
.md-body pre > .md-copy-btn:focus-visible {
    opacity: 1;
    color: var(--p-text-color);
}
.md-body pre > .md-copy-btn.is-copied {
    opacity: 1;
    color: var(--p-primary-color);
    border-color: var(--p-primary-color);
}
.md-body pre > .md-copy-btn.is-failed {
    opacity: 1;
    color: #b31d28;
    border-color: #b31d28;
}
.md-body pre > code {
    background: transparent;
    padding: 0;
}
/* #440: highlight.js token theme, scoped to rendered bodies. Hand-written
   (github-ish) so it follows aiball's `.aiball-dark` class toggle without
   shipping two theme files. Light defaults + dark overrides below. */
.md-body .hljs-comment, .md-body .hljs-quote { color: #6a737d; font-style: italic; }
.md-body .hljs-keyword, .md-body .hljs-selector-tag, .md-body .hljs-meta-keyword { color: #d73a49; }
.md-body .hljs-string, .md-body .hljs-meta .hljs-string, .md-body .hljs-regexp { color: #032f62; }
.md-body .hljs-number, .md-body .hljs-literal, .md-body .hljs-built_in,
.md-body .hljs-attr, .md-body .hljs-symbol, .md-body .hljs-bullet { color: #005cc5; }
.md-body .hljs-title, .md-body .hljs-section, .md-body .hljs-name,
.md-body .hljs-selector-id, .md-body .hljs-selector-class { color: #6f42c1; }
.md-body .hljs-type, .md-body .hljs-class .hljs-title { color: #d73a49; }
.md-body .hljs-attribute, .md-body .hljs-variable, .md-body .hljs-template-variable { color: #e36209; }
.md-body .hljs-tag { color: #22863a; }
.md-body .hljs-meta { color: #6a737d; }
.md-body .hljs-addition { color: #22863a; background: #f0fff4; }
.md-body .hljs-deletion { color: #b31d28; background: #ffeef0; }
.md-body .hljs-emphasis { font-style: italic; }
.md-body .hljs-strong { font-weight: 600; }
.aiball-dark .md-body .hljs-comment, .aiball-dark .md-body .hljs-quote { color: #8b949e; }
.aiball-dark .md-body .hljs-keyword, .aiball-dark .md-body .hljs-selector-tag,
.aiball-dark .md-body .hljs-meta-keyword { color: #ff7b72; }
.aiball-dark .md-body .hljs-string, .aiball-dark .md-body .hljs-meta .hljs-string,
.aiball-dark .md-body .hljs-regexp { color: #a5d6ff; }
.aiball-dark .md-body .hljs-number, .aiball-dark .md-body .hljs-literal,
.aiball-dark .md-body .hljs-built_in, .aiball-dark .md-body .hljs-symbol,
.aiball-dark .md-body .hljs-bullet { color: #79c0ff; }
.aiball-dark .md-body .hljs-attr { color: #79c0ff; }
.aiball-dark .md-body .hljs-title, .aiball-dark .md-body .hljs-section,
.aiball-dark .md-body .hljs-name, .aiball-dark .md-body .hljs-selector-id,
.aiball-dark .md-body .hljs-selector-class { color: #d2a8ff; }
.aiball-dark .md-body .hljs-type, .aiball-dark .md-body .hljs-class .hljs-title { color: #ff7b72; }
.aiball-dark .md-body .hljs-attribute, .aiball-dark .md-body .hljs-variable,
.aiball-dark .md-body .hljs-template-variable { color: #ffa657; }
.aiball-dark .md-body .hljs-tag { color: #7ee787; }
.aiball-dark .md-body .hljs-meta { color: #8b949e; }
.aiball-dark .md-body .hljs-addition { color: #aff5b4; background: #033a16; }
.aiball-dark .md-body .hljs-deletion { color: #ffdcd7; background: #67060c; }
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
/* #160 Phase 1 — upstream-provider chips (gh#NNN style). Visuellement
 * proche du mention chip mais teinté différemment pour distinguer
 * « ref externe » vs « ref interne aiball ». Couleur générique par
 * défaut + override par provider (github = colour spécifique GitHub). */
.md-body .upstream-ref {
    display: inline-block;
    padding: 0.05rem 0.35rem;
    border-radius: 0.25rem;
    background: color-mix(in srgb, var(--p-text-muted-color) 14%, transparent);
    color: var(--p-text-color);
    font-weight: 500;
    font-size: 0.92em;
    text-decoration: none;
}
.md-body .upstream-ref:hover { background: color-mix(in srgb, var(--p-text-muted-color) 24%, transparent); }
.md-body .upstream-ref--github {
    background: color-mix(in srgb, #6e7681 18%, transparent);
    color: #1f2328;
}
/* #723 — AttachmentCard : compact row (icon + name + size + DL +
   optional preview toggle) with a collapsible preview body below for
   text/code/markdown uploads. DL-only for binaries. */
.md-body .aiball-attachment {
    display: block;
    margin: 0.6em 0;
    padding: 0.45em 0.7em;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.35rem;
    background: var(--p-surface-50, color-mix(in srgb, var(--p-surface-100) 50%, transparent));
    font-size: 0.92em;
}
.md-body .aiball-attachment__row {
    display: flex;
    align-items: center;
    gap: 0.5em;
    flex-wrap: wrap;
}
.md-body .aiball-attachment__icon { flex: 0 0 auto; opacity: 0.7; }
.md-body .aiball-attachment__name {
    font-weight: 500;
    word-break: break-all;
}
.md-body .aiball-attachment__size {
    color: var(--p-text-muted-color);
    font-size: 0.85em;
}
.md-body .aiball-attachment__dl,
.md-body .aiball-attachment__toggle {
    margin-left: auto;
    padding: 0.15em 0.55em;
    font: inherit;
    font-size: 0.85em;
    line-height: 1.2;
    background: var(--p-surface-0, #fff);
    color: var(--p-text-color);
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.25rem;
    cursor: pointer;
    text-decoration: none;
}
.md-body .aiball-attachment__dl + .aiball-attachment__toggle { margin-left: 0; }
.md-body .aiball-attachment__dl:hover,
.md-body .aiball-attachment__toggle:hover,
.md-body .aiball-attachment__toggle:focus-visible {
    color: var(--p-primary-color);
    border-color: var(--p-primary-color);
}
.md-body .aiball-attachment__preview {
    margin-top: 0.5em;
    padding-top: 0.45em;
    border-top: 1px dashed var(--p-content-border-color);
}
.md-body .aiball-attachment__code {
    margin: 0;
    max-height: 24em;
    overflow: auto;
}
.md-body .aiball-attachment__md > :first-child { margin-top: 0; }
.md-body .aiball-attachment__truncated {
    margin-top: 0.3em;
    color: var(--p-text-muted-color);
    font-size: 0.82em;
    font-style: italic;
}
</style>
