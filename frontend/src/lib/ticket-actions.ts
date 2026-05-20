/**
 * Per-action applicability predicates. These tell the UI whether a
 * bulk button should be enabled, or whether a row should be skipped in
 * a multi-row operation (#B.327 — silent skip rather than refusing the
 * whole batch).
 *
 * They mirror what the server will accept, but live here so the UI can
 * pre-disable buttons without a round-trip. The daemon is still the
 * authoritative gate (owner-bypass, rule engine, …).
 *
 * Extracted from App.vue's bulkApplicable switch (#B.332 Phase D, per `#C.mf5h72`).
 *
 * `useBulkActions(...)` (bottom of file) is the App.vue-side composable
 * extracted in #B.213 phase A.1 — wraps selectedIds + bulkBusy + the
 * dispatch logic so App.vue doesn't carry ~140 LOC of bulk plumbing.
 */
import { computed, ref, type Ref } from "vue";
import { useToast } from "primevue/usetoast";
import { api, type InboxRow } from "./api";
import { bus } from "./bus";
import { isClosed, isOpen, isPending, isRejected, isSnoozed, isUnread } from "./ticket-state";

export type BulkAction =
    | "approve"
    | "reject"
    | "close"
    | "reopen"
    | "mark_read"
    | "mark_unread"
    | "snooze"
    | "unsnooze"
    | "link";

export function canApprove(r: InboxRow): boolean {
    return isPending(r);
}

export function canReject(r: InboxRow): boolean {
    return isPending(r);
}

export function canClose(r: InboxRow): boolean {
    return isOpen(r);
}

export function canReopen(r: InboxRow): boolean {
    return isClosed(r);
}

export function canSnooze(r: InboxRow): boolean {
    return !isRejected(r) && !isClosed(r) && !isSnoozed(r);
}

export function canUnsnooze(r: InboxRow): boolean {
    return isSnoozed(r);
}

export function canMarkRead(r: InboxRow): boolean {
    return isUnread(r);
}

export function canMarkUnread(r: InboxRow): boolean {
    return !isUnread(r);
}

/**
 * Any non-rejected ticket can participate in a bulk-link star (#B.236
 * dkrus4 — "le plus recent vois les autres"). The bulkAction handler
 * adds the eligibility floor (need ≥ 2 selected to create any edge);
 * the per-row predicate just gates which rows count.
 */
export function canLink(r: InboxRow): boolean {
    return !isRejected(r);
}

/**
 * Dispatch table — single entry point used by `bulkApplicable` so the
 * caller can ask "can I do X on this row?" without a switch.
 */
export const BULK_PREDICATES: Record<BulkAction, (r: InboxRow) => boolean> = {
    approve: canApprove,
    reject: canReject,
    close: canClose,
    reopen: canReopen,
    mark_read: canMarkRead,
    mark_unread: canMarkUnread,
    snooze: canSnooze,
    unsnooze: canUnsnooze,
    link: canLink,
};

export function canDo(action: BulkAction, r: InboxRow): boolean {
    return BULK_PREDICATES[action](r);
}

export const BULK_LABELS: Record<BulkAction, string> = {
    approve: "approve",
    reject: "reject",
    close: "close",
    reopen: "reopen",
    mark_read: "mark read",
    mark_unread: "mark unread",
    snooze: "snooze",
    unsnooze: "unsnooze",
    link: "link",
};

/** Default snooze duration when the bulk button is clicked without a
 *  picker — matches the "+3d" preset of the thread popover. */
const BULK_SNOOZE_DEFAULT_MS = 3 * 86_400_000;

/**
 * App.vue's bulk-selection state + dispatch logic, packaged as a
 * composable (#B.213 phase A.1). `rows` is the full unfiltered set
 * (used by bulk dispatch + applicability counts); `pagedRows` is the
 * current page (used by selectAllVisible). Emits `inbox.refresh` and
 * `projects.refresh` on the bus after each batch so the loaders pick
 * up the new state.
 */
export function useBulkActions(opts: {
    rows: Ref<InboxRow[]>;
    pagedRows: Ref<InboxRow[]>;
}) {
    const { rows, pagedRows } = opts;
    const toast = useToast();
    const selectedIds = ref<Set<number>>(new Set());
    const bulkBusy = ref(false);

    function toggleSelected(id: number, v: boolean) {
        const next = new Set(selectedIds.value);
        if (v) next.add(id);
        else next.delete(id);
        selectedIds.value = next;
    }

    function clearSelection() {
        selectedIds.value = new Set();
    }

    function selectAllVisible() {
        // "Visible" = the current page's rows. With pagination on, selecting
        // "all" across every page would be surprising; the user sees 25 rows
        // and expects the button to act on those. To select across pages,
        // they can paginate + select-all again — selectedIds persists.
        selectedIds.value = new Set(pagedRows.value.map((r) => r.id));
    }

    /**
     * Per-row applicability test for each bulk action. Rows that don't
     * pass are silently skipped (no API call, no error), per #B.327: a
     * bulk action should never refuse the whole batch because some rows
     * weren't eligible — it just acts on the ones it can.
     */
    async function bulkAction(action: BulkAction) {
        const selected = rows.value.filter((r) => selectedIds.value.has(r.id));
        if (!selected.length) return;
        bulkBusy.value = true;
        // #B.236: bulk-link is special — it's a single STAR operation,
        // not a per-row loop. Pick the most recent eligible row as the
        // source and add `relates_to` edges from it to each of the
        // others (david dkrus4 "le plus recent vois les autres").
        if (action === "link") {
            const eligible = selected.filter((r) => canLink(r));
            // Sort newest-first by created_at. ISO8601 strings compare
            // lexicographically the same way as their timestamps.
            eligible.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            const source = eligible[0];
            const targets = eligible.slice(1);
            let ok = 0, failed = 0;
            const linkSkipped = selected.length - eligible.length;
            try {
                for (const t of targets) {
                    try {
                        await api.addRelation(source.id, t.id, "relates_to");
                        ok++;
                    } catch {
                        failed++;
                    }
                }
                let detail = "";
                if (linkSkipped) detail += `${linkSkipped} skipped (rejected)`;
                if (failed) detail += `${detail ? ", " : ""}${failed} failed`;
                if (!targets.length && !linkSkipped) {
                    detail = "need ≥ 2 tickets selected";
                }
                toast.add({
                    severity: failed || !ok ? "warn" : "success",
                    summary: ok
                        ? `linked ${ok} ticket${ok === 1 ? "" : "s"} to #B.${source.id}`
                        : "link: no edge created",
                    detail: detail || undefined,
                    life: 6000,
                });
                clearSelection();
                bus.emit("inbox.refresh");
                bus.emit("projects.refresh");
            } finally {
                bulkBusy.value = false;
            }
            return;
        }
        let ok = 0, skipped = 0, failed = 0;
        try {
            for (const r of selected) {
                if (!canDo(action, r)) {
                    skipped++;
                    continue;
                }
                try {
                    switch (action) {
                        case "approve":
                            await api.approve(r.id);
                            break;
                        case "reject":
                            await api.reject(r.id);
                            break;
                        case "close":
                            await api.postMessage({
                                project: r.project,
                                kind: "ticket_closed",
                                ticket_id: r.id,
                                parent_id: r.id,
                            });
                            break;
                        case "reopen":
                            await api.postMessage({
                                project: r.project,
                                kind: "ticket_reopened",
                                ticket_id: r.id,
                                parent_id: r.id,
                            });
                            break;
                        case "mark_read":
                            await api.markTicketRead(r.id);
                            break;
                        case "mark_unread":
                            await api.markTicketUnread(r.id);
                            break;
                        case "snooze":
                            await api.postponeTicket(
                                r.id,
                                new Date(Date.now() + BULK_SNOOZE_DEFAULT_MS).toISOString(),
                            );
                            break;
                        case "unsnooze":
                            await api.unsnoozeTicket(r.id);
                            break;
                    }
                    ok++;
                } catch {
                    failed++;
                }
            }
            const label = BULK_LABELS[action];
            let detail = "";
            if (skipped) detail += `${skipped} skipped (not applicable)`;
            if (failed) detail += `${detail ? ", " : ""}${failed} failed`;
            toast.add({
                severity: failed ? "warn" : "success",
                summary: `${label}: ${ok} ticket${ok === 1 ? "" : "s"}`,
                detail: detail || undefined,
                life: 6000,
            });
            clearSelection();
            bus.emit("inbox.refresh");
            bus.emit("projects.refresh");
        } finally {
            bulkBusy.value = false;
        }
    }

    /** Count how many selected rows would actually be touched by `action`.
     *  Used to disable the bulk button when no row is eligible. */
    function bulkApplicableCount(action: BulkAction): number {
        let n = 0;
        for (const r of rows.value) {
            if (selectedIds.value.has(r.id) && canDo(action, r)) n++;
        }
        return n;
    }

    const bulkCounts = computed(() => {
        // Link is shown only when ≥ 2 rows can participate — a single
        // ticket can't be linked to itself. The button hides via the
        // `counts[action]` truthiness check in BulkBar.
        const linkable = bulkApplicableCount("link");
        return {
            approve: bulkApplicableCount("approve"),
            reject: bulkApplicableCount("reject"),
            close: bulkApplicableCount("close"),
            reopen: bulkApplicableCount("reopen"),
            mark_read: bulkApplicableCount("mark_read"),
            mark_unread: bulkApplicableCount("mark_unread"),
            snooze: bulkApplicableCount("snooze"),
            unsnooze: bulkApplicableCount("unsnooze"),
            link: linkable >= 2 ? linkable : 0,
        };
    });

    return {
        selectedIds,
        bulkBusy,
        toggleSelected,
        clearSelection,
        selectAllVisible,
        bulkAction,
        bulkApplicableCount,
        bulkCounts,
    };
}
