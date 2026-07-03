import { computed, ref, watch, type Ref } from "vue";
import { INTENTS, PRIORITIES, type Intent, type Priority } from "./api";
import type { Scope } from "./scope";

// Composer persistence composable — pure storage side-effects, no
// template. Two concerns extracted from MessageComposer.vue:
//   - per-thread / per-project DRAFT persistence (sessionStorage);
//   - last-chosen SCOPE persistence (localStorage) — it owns the
//     `scope` ref itself.

type ComposerMode = "ticket" | "comment";

export function useComposerDraft(opts: {
    mode: Ref<ComposerMode>;
    project: Ref<string>;
    ticketId: Ref<number | undefined>;
    title: Ref<string>;
    body: Ref<string>;
    intent: Ref<Intent>;
    priority: Ref<Priority>;
}) {
    const { mode, project, ticketId, title, body, intent, priority } = opts;
    const isTicket = computed(() => mode.value === "ticket");

    // #B.245 tristate scope (unified internal/broadcast):
    //   internal  → owners only + @mentions explicites
    //   default   → ticket subs + project owners + @mentions
    //   broadcast → default + project followers
    //
    // David #79h7zk: "le widget gardera la dernière valeur choisie par
    // ticket" — the composer persists the last-chosen scope per-ticket
    // via localStorage so the user doesn't have to re-pick it on every
    // reply within a thread. New tickets get a per-project memory.
    // Initial fallback: `default` for every mode (#253 — david: replies
    // should default to `default`, not `internal`. The prior ny8m8a
    // directive favouring `internal` for replies was reversed once david
    // tried it live).
    const scopeStorageKey = computed(() => {
        if (mode.value === "comment" && ticketId.value !== undefined) {
            return `aiball.composer.scope.${ticketId.value}`;
        }
        return `aiball.composer.scope.new.${project.value}`;
    });
    function readPersistedScope(): Scope | null {
        const raw = localStorage.getItem(scopeStorageKey.value);
        if (raw === "internal" || raw === "default" || raw === "broadcast") return raw;
        return null;
    }
    const scope = ref<Scope>(readPersistedScope() ?? "default");
    watch(scope, (next) => {
        localStorage.setItem(scopeStorageKey.value, next);
    });

    // Per-thread / per-project draft persistence (per #B.94). The composer
    // preserves what's been typed across page refreshes and thread
    // navigation: a reply on `#B.42` keeps its own draft, a reply on
    // `#B.43` keeps its own, and the new-ticket modal in `aiball` keeps
    // its own. Cleared on successful submit.
    const draftKey = computed(() => {
        if (isTicket.value) return `aiball.draft.composer.ticket.${project.value}`;
        const tid = ticketId.value ?? "untargeted";
        return `aiball.draft.composer.comment.${tid}`;
    });

    function loadDraft() {
        const saved = sessionStorage.getItem(draftKey.value);
        if (saved === null) {
            // No draft for this scope → start with a clean slate.
            title.value = "";
            body.value = "";
            return;
        }
        if (isTicket.value) {
            try {
                const parsed = JSON.parse(saved) as {
                    title?: string;
                    body?: string;
                    intent?: Intent;
                    priority?: Priority;
                };
                title.value = typeof parsed.title === "string" ? parsed.title : "";
                body.value = typeof parsed.body === "string" ? parsed.body : "";
                if (parsed.intent && (INTENTS as readonly string[]).includes(parsed.intent)) {
                    intent.value = parsed.intent;
                }
                if (parsed.priority && (PRIORITIES as readonly string[]).includes(parsed.priority)) {
                    priority.value = parsed.priority;
                }
            } catch {
                // Corrupted draft — start fresh.
                title.value = "";
                body.value = "";
            }
        } else {
            // Comment mode: stored as plain string (body only).
            body.value = saved;
        }
    }

    // Re-run on mount AND whenever the scope (project / ticketId / mode)
    // changes. Vue reuses the same component instance across thread
    // navigation, so a watch is the right hook for "the composer now
    // belongs to a different conversation, reload its draft".
    watch(
        [mode, project, ticketId],
        loadDraft,
        { immediate: true },
    );

    // Mirror typing into sessionStorage. Cleared (instead of stored with
    // empty values) when both fields are empty so we don't leave
    // zero-content keys around.
    watch([title, body, intent, priority], () => {
        const key = draftKey.value;
        if (isTicket.value) {
            const empty = !title.value && !body.value
                && intent.value === "request"
                && priority.value === "normal";
            if (empty) sessionStorage.removeItem(key);
            else sessionStorage.setItem(
                key,
                JSON.stringify({
                    title: title.value,
                    body: body.value,
                    intent: intent.value,
                    priority: priority.value,
                }),
            );
        } else {
            if (!body.value) sessionStorage.removeItem(key);
            else sessionStorage.setItem(key, body.value);
        }
    });

    return {
        scope,
        scopeStorageKey,
        readPersistedScope,
        draftKey,
        loadDraft,
    };
}
