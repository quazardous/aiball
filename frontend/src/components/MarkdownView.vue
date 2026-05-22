<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import DOMPurify from "dompurify";
import { bus } from "../lib/bus";
import { promoteTrigger } from "../lib/prefs";
import { extractQuestions } from "../lib/questions";
import { applyPostSanitize, markedInstance, patterns } from "../lib/formatting";

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
}>();

// Linkify cross-message refs (`#B.123`, `#C.<hashid>`) and `@mentions`.
// The patterns are no longer hardcoded here — they come from the merged
// config (`GET /api/config`, #B.235) via `../lib/formatting`, which seeds
// in-code defaults synchronously and swaps in the effective set once the
// fetch resolves. `markedInstance` carries the inline link extensions;
// `applyPostSanitize` handles the post-sanitize passes (codespan refs +
// `@mention` spans). Both are reactive so a live config change re-renders.
const html = computed(() => {
    const src = props.source ?? "";
    if (!src) return "";
    const raw = markedInstance.value.parse(src, { async: false }) as string;
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
    return applyPostSanitize(sanitized, patterns.value);
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

// `immediate: true` so the very first render also wires clicks —
// `watch` without it only fires on subsequent changes, which means a
// freshly mounted MarkdownView would leave its checkboxes inert until
// the source changes again.
watch(html, () => { void wireQuestionClicks(); }, { flush: "post", immediate: true });
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
    background: var(--p-surface-100);
    padding: 0.6em 0.8em;
    border-radius: 0.3rem;
    overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
}
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
