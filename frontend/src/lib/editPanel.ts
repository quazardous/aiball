/**
 * Inline edit-panel composable for the title + body fields of a
 * ticket (#B.196 Layer 3 extract from ThreadView). Owns the drafts,
 * the busy flag, the sessionStorage mirror (so a page refresh
 * mid-edit doesn't lose typing, per #B.76 reopen), the save/cancel
 * verbs, and the paste-image attach/detach on the body textarea.
 *
 * Intent + tag picker save live and live OUTSIDE this composable —
 * those handlers stay in the parent (they pair with the article
 * header pickers, not just the edit panel).
 *
 * Caller wires `data` + the parent's `ticketId` getter + an `editing`
 * ref (controls the watchers + mutated on save/cancel), an error
 * sink, and a broadcastRefresh callback for the post-save bus emit.
 */
import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import { useToast } from "primevue/usetoast";
import { api, type ThreadView as ThreadViewData } from "./api";
import { attachPasteImage } from "./pasteImage";

interface UseEditPanelArgs {
    data: Ref<ThreadViewData | null>;
    ticketId: () => number;
    editing: Ref<boolean>;
    error: Ref<string | null>;
    broadcastRefresh: (ticketId: number) => void;
}

function draftKey(ticketId: number): string {
    return `aiball.draft.ticket.${ticketId}`;
}

export function useEditPanel({ data, ticketId, editing, error, broadcastRefresh }: UseEditPanelArgs) {
    const titleDraft = ref("");
    const bodyDraft = ref("");
    const bodyBusy = ref(false);
    const editPanelRef = ref<{ bodyTextareaRef: { $el?: HTMLTextAreaElement } | null } | null>(null);
    const toast = useToast();
    let detachPaste: (() => void) | null = null;

    // Seed drafts from sessionStorage (or fall back to DB values) any
    // time the edit panel opens — handles fresh open + page refresh
    // mid-edit + ticket switch while the panel is open.
    watch(
        [ticketId, editing, () => data.value?.ticket.id],
        () => {
            if (!editing.value || !data.value) return;
            const tid = data.value.ticket.id;
            const saved = sessionStorage.getItem(draftKey(tid));
            if (saved !== null) {
                try {
                    const { title, body } = JSON.parse(saved) as { title?: string; body?: string };
                    titleDraft.value = typeof title === "string" ? title : (data.value.ticket.title ?? "");
                    bodyDraft.value = typeof body === "string" ? body : (data.value.ticket.body ?? "");
                    return;
                } catch {
                    // Corrupted draft — fall through to DB values.
                }
            }
            titleDraft.value = data.value.ticket.title ?? "";
            bodyDraft.value = data.value.ticket.body ?? "";
        },
    );

    // Mirror drafts into sessionStorage on every change while editing.
    watch([titleDraft, bodyDraft], ([t, b]) => {
        if (!editing.value || !data.value) return;
        sessionStorage.setItem(
            draftKey(data.value.ticket.id),
            JSON.stringify({ title: t, body: b }),
        );
    });

    /**
     * Save any pending title + body changes and close the edit panel.
     * Title and body draft mutations are buffered (no auto-save on
     * blur), so a single click on "save" — or Ctrl/Cmd+Enter inside
     * the body — commits both fields in one shot. Intent and tags
     * save live and aren't part of this commit cycle.
     */
    async function saveAndClose() {
        if (!data.value) return;
        const tid = data.value.ticket.id;
        const currentTitle = data.value.ticket.title ?? "";
        const currentBody = data.value.ticket.body ?? "";
        const titleChanged = titleDraft.value !== currentTitle;
        const bodyChanged = bodyDraft.value !== currentBody;
        if (!titleChanged && !bodyChanged) {
            editing.value = false;
            return;
        }
        bodyBusy.value = true;
        try {
            const patch: { title?: string; body?: string } = {};
            if (titleChanged) patch.title = titleDraft.value;
            if (bodyChanged) patch.body = bodyDraft.value;
            await api.edit(tid, patch);
            sessionStorage.removeItem(draftKey(tid));
            broadcastRefresh(tid);
            editing.value = false;
        } catch (e) {
            error.value = (e as Error).message;
            // Rollback drafts so the panel reflects what's actually in the DB.
            if (titleChanged) titleDraft.value = currentTitle;
            if (bodyChanged) bodyDraft.value = currentBody;
        } finally {
            bodyBusy.value = false;
        }
    }

    /**
     * Drop any unsaved title/body edits and close the panel. Intent
     * and tags changes made during the session aren't reverted —
     * those saved live the moment the user changed them. Also clears
     * the sessionStorage draft so the next open re-seeds from the DB.
     */
    function cancel() {
        if (data.value) {
            sessionStorage.removeItem(draftKey(data.value.ticket.id));
            titleDraft.value = data.value.ticket.title ?? "";
            bodyDraft.value = data.value.ticket.body ?? "";
        }
        editing.value = false;
    }

    // Paste-image on the body textarea of the edit panel (per #B.76).
    // ThreadEditPanel mounts/unmounts the textarea with `v-if="editing"`
    // and exposes its ref via defineExpose; we read it off
    // editPanelRef and (re)attach on each transition.
    watch(() => editPanelRef.value?.bodyTextareaRef ?? null, (instance) => {
        detachPaste?.();
        detachPaste = null;
        const el = instance?.$el;
        if (!el) return;
        detachPaste = attachPasteImage(el, bodyDraft, {
            onError(err) {
                toast.add({
                    severity: "error",
                    summary: "Image paste failed",
                    detail: err.message,
                    life: 5000,
                });
            },
        });
    });

    onBeforeUnmount(() => detachPaste?.());

    return {
        titleDraft,
        bodyDraft,
        bodyBusy,
        editPanelRef,
        saveAndClose,
        cancel,
    };
}
