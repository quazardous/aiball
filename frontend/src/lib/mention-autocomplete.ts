import { computed, onMounted, ref, watch, type Ref } from "vue";
import { api } from "./api";

// =====================================================================
//  @-mention autocomplete (#B.71)
// =====================================================================
//
// Inline popover anchored below the textarea. Triggered by typing `@`
// (or scrolling the caret back to an existing @-token). Suggestions:
// projects first (folder icon), agents second (user icon). Selection
// replaces the partial `@xxx` with the full `@name `.
//
// Script-only composable: the popover template + its CSS live in
// MessageComposer.vue — only the machinery was extracted here.

export interface MentionSuggestion {
    kind: "project" | "agent";
    value: string;
}

// #515 — filtre catégorie. Default "all" (les 2 mélangés avec icônes
// distinctes pi-folder / pi-user). L'utilisateur peut narrow sur agents
// uniquement ou projects uniquement via les chips du header de popover.
export type MentionFilter = "all" | "agents" | "projects";

export function useMentionAutocomplete(
    // The PrimeVue Textarea component ref ($el = the real <textarea>).
    textareaRef: Ref<{ $el?: HTMLTextAreaElement } | null>,
    // The composer body model — mention selection rewrites it in place.
    body: Ref<string>,
) {
    const mentionCatalog = ref<{ projects: string[]; agents: string[] } | null>(null);
    const mentionQuery = ref<string | null>(null);  // null = popover closed
    const mentionTokenStart = ref(0);                // body index where the `@` sits
    const mentionSelectedIdx = ref(0);
    const mentionFilter = ref<MentionFilter>("all");

    onMounted(() => {
        // Same gating as pre-extraction: the fetch only ran once the
        // textarea element existed.
        const el = textareaRef.value?.$el;
        if (!el) return;
        // Load the @-mention catalog once (per #B.71). Cheap; the daemon
        // builds it from SELECT DISTINCT across subs/tickets/messages.
        api.mentionSuggestions()
            .then((r) => { mentionCatalog.value = r; })
            .catch(() => { /* offline OK — autocomplete just stays inert */ });
    });

    const mentionSuggestions = computed<MentionSuggestion[]>(() => {
        if (mentionQuery.value === null || !mentionCatalog.value) return [];
        const q = mentionQuery.value.toLowerCase();
        const matchProj = mentionFilter.value === "agents"
            ? []
            : mentionCatalog.value.projects.filter((p) => p.toLowerCase().includes(q));
        const matchAgent = mentionFilter.value === "projects"
            ? []
            : mentionCatalog.value.agents.filter((a) => a.toLowerCase().includes(q));
        return [
            ...matchProj.map((v): MentionSuggestion => ({ kind: "project", value: v })),
            ...matchAgent.map((v): MentionSuggestion => ({ kind: "agent", value: v })),
        ].slice(0, 8);
    });

    // #515 — quand on switche de filtre, l'index sélectionné peut pointer hors
    // de la nouvelle liste plus courte. Reset à 0 pour éviter un highlight cassé.
    function setMentionFilter(f: MentionFilter) {
        mentionFilter.value = f;
        mentionSelectedIdx.value = 0;
    }

    function detectMentionAtCaret() {
        const el = textareaRef.value?.$el;
        if (!el) {
            mentionQuery.value = null;
            return;
        }
        const caret = el.selectionStart ?? 0;
        const before = body.value.slice(0, caret);
        // Most recent `@` preceded by start-of-line or non-word non-@ char,
        // followed by 0..N word/dash/underscore chars, ending at caret.
        const m = before.match(/(?:^|[^\w@])@([a-zA-Z0-9_-]*)$/);
        if (!m) {
            mentionQuery.value = null;
            return;
        }
        mentionQuery.value = m[1];
        mentionTokenStart.value = caret - m[1].length - 1; // position of `@`
        mentionSelectedIdx.value = 0;
    }

    function onComposerInput() {
        // setTimeout(0) rather than rAF because rAF is throttled when the
        // browser tab is in background (the autocomplete still needs to
        // respond to typing even if the tab isn't focused).
        setTimeout(detectMentionAtCaret, 0);
    }

    // Belt + braces: also re-evaluate when body changes via paste, drafts,
    // programmatic edits, etc. The @input handler above covers the typical
    // typing path; this watch handles everything else.
    watch(body, () => {
        setTimeout(detectMentionAtCaret, 0);
    });

    function onComposerKeydown(ev: KeyboardEvent) {
        if (mentionQuery.value === null || mentionSuggestions.value.length === 0) {
            // Re-evaluate after arrow/backspace movements that change the caret.
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(ev.key)) {
                // setTimeout(0) rather than rAF because rAF is throttled when the
                // browser tab is in background (the autocomplete still needs to
                // respond to typing even if the tab isn't focused).
                setTimeout(detectMentionAtCaret, 0);
            }
            return;
        }
        if (ev.key === "ArrowDown") {
            ev.preventDefault();
            mentionSelectedIdx.value =
                (mentionSelectedIdx.value + 1) % mentionSuggestions.value.length;
            return;
        }
        if (ev.key === "ArrowUp") {
            ev.preventDefault();
            mentionSelectedIdx.value =
                (mentionSelectedIdx.value - 1 + mentionSuggestions.value.length) %
                mentionSuggestions.value.length;
            return;
        }
        if (ev.key === "Enter" || ev.key === "Tab") {
            ev.preventDefault();
            selectMention(mentionSuggestions.value[mentionSelectedIdx.value]);
            return;
        }
        if (ev.key === "Escape") {
            ev.preventDefault();
            mentionQuery.value = null;
            return;
        }
    }

    function selectMention(s: MentionSuggestion) {
        const el = textareaRef.value?.$el;
        if (!el || mentionQuery.value === null) return;
        const start = mentionTokenStart.value;
        const end = start + 1 + mentionQuery.value.length;
        body.value = `${body.value.slice(0, start)}@${s.value} ${body.value.slice(end)}`;
        mentionQuery.value = null;
        setTimeout(() => {
            const pos = start + s.value.length + 2; // @ + name + space
            el.focus();
            el.setSelectionRange(pos, pos);
        }, 0);
    }

    return {
        mentionCatalog,
        mentionQuery,
        mentionTokenStart,
        mentionSelectedIdx,
        mentionFilter,
        mentionSuggestions,
        setMentionFilter,
        detectMentionAtCaret,
        onComposerInput,
        onComposerKeydown,
        selectMention,
    };
}
