/**
 * Per-thread relation management (#B.196 Layer 3 extract from
 * ThreadView). Owns the add-form state (open + target text + kind
 * + busy), the per-chip menu state (popover ref + target +
 * cached title), every verb that mutates relations on the open
 * thread (add / change-kind / remove via tombstone), and the bus
 * listener that opens the menu on a right-click on any `.ticket-ref`
 * in a rendered body.
 *
 * Caller passes the loaded `data` ref + a `load` callback that
 * re-fetches the thread after a mutation. Toasts are emitted via
 * `useToast()` directly; the composable owns its own toast handle.
 */
import { ref, type Ref } from "vue";
import { useToast } from "primevue/usetoast";
import type Popover from "primevue/popover";
import { api, type ThreadView as ThreadViewData } from "./api";
import { useBus } from "./bus";
import { RELATION_KINDS, RELATION_LABELS, isLineageRelationKind, type RelationKind } from "./relations";

interface UseThreadRelationsArgs {
    data: Ref<ThreadViewData | null>;
    load: () => Promise<void>;
}

export function useThreadRelations({ data, load }: UseThreadRelationsArgs) {
    const toast = useToast();

    // Add-form state — expands under the relations chips row when the
    // user clicks "+ relation". Target id parsed from input (accepts
    // "42", "#B.42" or "B.42"); kind defaults to relates_to. Errors
    // surface in toast.
    const addRelationOpen = ref(false);
    const newRelationTarget = ref("");
    const newRelationKind = ref<RelationKind>("relates_to");
    const addRelationBusy = ref(false);
    // #271: lineage kinds (child_of / parent_of) are auto-written on
    // sub-ticket creation and aren't offered in the manual add-form.
    const relationKindOptions = RELATION_KINDS
        .filter((k) => !isLineageRelationKind(k))
        .map((k) => ({
            label: RELATION_LABELS[k],
            value: k,
        }));

    // #B.123 phase B.2.c: change-kind / remove on each relation chip.
    // Posting a NEW ticket_relation event with the same target
    // replaces the kind (latest-event-wins). Removing = posting with
    // kind=ignored (tombstone in the replay). Both go through the
    // same POST endpoint as add, no PATCH/DELETE.
    async function changeRelationKind(targetId: number, newKind: RelationKind) {
        if (!data.value) return;
        addRelationBusy.value = true;
        try {
            await api.addRelation(data.value.ticket.id, targetId, newKind);
            await load();
        } catch (e) {
            toast.add({
                severity: "error",
                summary: "Could not change relation",
                detail: (e as Error).message,
                life: 6000,
            });
        } finally {
            addRelationBusy.value = false;
        }
    }

    async function removeRelation(targetId: number) {
        // Tombstone via POST kind=ignored — no confirm dialog;
        // re-adding is one click via the + relation widget,
        // low-stakes mistake.
        return changeRelationKind(targetId, "ignored");
    }

    // Single shared Popover for per-chip kind/remove menu — track
    // which relation it currently anchors so the menu body re-renders
    // correctly. `kind` is null when the menu was triggered by a
    // fresh ticket-ref promote (#B.123 phase B.5) — no existing
    // relation yet, the picker creates one. Otherwise it carries the
    // existing kind (chip edit).
    const menuRef = ref<InstanceType<typeof Popover> | null>(null);
    const menuTarget = ref<{ target_ticket_id: number; kind: RelationKind | null } | null>(null);
    // #B.123 follow-up: fetched title of the referenced ticket so the
    // popover header reads "→ #B.NN — <title>" instead of just the
    // number. Null while loading (or unfetched). Cached in-memory
    // across pop-overs in the same session.
    const menuTargetTitle = ref<string | null>(null);
    const titleCache = new Map<number, string>();

    async function loadMenuTargetTitle(ticketId: number): Promise<void> {
        const cached = titleCache.get(ticketId);
        if (cached !== undefined) {
            menuTargetTitle.value = cached;
            return;
        }
        menuTargetTitle.value = null;
        try {
            const resp = await api.getTicket(ticketId);
            const title = resp?.ticket?.title ?? "";
            titleCache.set(ticketId, title);
            // Only update if the popover still targets this id (user
            // might have closed + re-opened on a different ref).
            if (menuTarget.value?.target_ticket_id === ticketId) {
                menuTargetTitle.value = title;
            }
        } catch {
            /* silent — popover just shows the number alone */
        }
    }

    function openMenu(
        ev: Event,
        r: { target_ticket_id: number; kind: RelationKind },
    ) {
        menuTarget.value = { target_ticket_id: r.target_ticket_id, kind: r.kind };
        void loadMenuTargetTitle(r.target_ticket_id);
        menuRef.value?.show(ev);
    }

    // #B.123 phase B.5: bus listener — right-click on a `.ticket-ref`
    // in a rendered body opens the same menu, pre-targeting the
    // referenced ticket (current kind looked up from
    // data.ticket.relations if any).
    useBus("ticket-ref.promote", (payload) => {
        if (!data.value) return;
        // Self-references are filtered upstream in MarkdownView (it
        // gets selfTicketId as a prop and skips the @contextmenu
        // intercept so the browser's native menu can show on those
        // links). David #B.123: "on peut filtrer le popup".
        const existing = (data.value.ticket.relations ?? []).find(
            (r) => r.target_ticket_id === payload.ticket_id,
        );
        menuTarget.value = {
            target_ticket_id: payload.ticket_id,
            kind: existing?.kind ?? null,
        };
        void loadMenuTargetTitle(payload.ticket_id);
        // Synthesize an event whose currentTarget IS the link.
        // PrimeVue Popover stores event.currentTarget in
        // this.eventTarget, then uses it for outside-click detection
        // (eventTarget.contains(...) — anything inside is treated
        // as "click on the trigger" and the popover stays open).
        // With the raw @contextmenu event, currentTarget = .md-body,
        // so EVERY click in the comment body kept the popover open
        // (david #C.5aqzef: "si on clique à côté ça doit disparaitre").
        // Synthetic event with currentTarget = link element scopes
        // the trigger to just the link → outside-click anywhere else
        // now closes properly.
        const fakeEvent = { currentTarget: payload.target, target: payload.target } as unknown as Event;
        menuRef.value?.show(fakeEvent, payload.target);
    });

    async function pickKind(newKind: RelationKind) {
        const t = menuTarget.value;
        if (!t) return;
        menuRef.value?.hide();
        await changeRelationKind(t.target_ticket_id, newKind);
    }

    async function deleteFromMenu() {
        const t = menuTarget.value;
        if (!t) return;
        menuRef.value?.hide();
        await removeRelation(t.target_ticket_id);
    }

    async function submitNew() {
        if (!data.value) return;
        const raw = newRelationTarget.value.trim().replace(/^#?B?\.?/i, "");
        const target = Number(raw);
        if (!Number.isFinite(target) || target <= 0) {
            toast.add({
                severity: "warn",
                summary: "Invalid target ticket id",
                detail: "Type a ticket number, e.g. 42 or #B.42",
                life: 4000,
            });
            return;
        }
        addRelationBusy.value = true;
        try {
            await api.addRelation(data.value.ticket.id, target, newRelationKind.value);
            await load();
            addRelationOpen.value = false;
            newRelationTarget.value = "";
            newRelationKind.value = "relates_to";
        } catch (e) {
            toast.add({
                severity: "error",
                summary: "Could not add relation",
                detail: (e as Error).message,
                life: 6000,
            });
        } finally {
            addRelationBusy.value = false;
        }
    }

    return {
        // Add form
        addRelationOpen,
        newRelationTarget,
        newRelationKind,
        addRelationBusy,
        relationKindOptions,
        submitNew,
        // Per-chip menu
        menuRef,
        menuTarget,
        menuTargetTitle,
        openMenu,
        pickKind,
        deleteFromMenu,
        // Direct mutations (used by RelationChip / RelationKindMenu)
        changeRelationKind,
        removeRelation,
    };
}
