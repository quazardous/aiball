// #2072 — the inbox cache: ONE owner for the rows, and the only writer.
//
// david: "si les events sont déclaratifs et passent par un bus, chaque
// composant peut réagir comme il le veut — il suffit de dire dans quel ordre
// les listeners s'exécutent".
//
// The first half is what this builds. The second half turns out not to be
// needed, and that is the interesting part: you only have to order WRITERS,
// and there is one. The list, the pager and the bulk bar are readers, and
// Vue's reactivity repaints them whenever this state changes — before or
// after, early or late, it does not matter to a reader.
//
// Ordering would also not have been enough on its own. Bus handlers run
// synchronously; refreshing a row is asynchronous. Declaring "cache first,
// list second" would have run the list while the cache was still waiting for
// its response — the order respected and the result wrong.
//
// So the rule is: everything that writes `rows` lives here. A component that
// wants ticket data reads it; a component that wants to change it calls a
// method. Nothing else touches the array.

import { ref, type Ref } from "vue";
import { api, type InboxRow, type Message, type Priority } from "./api";
import { useBus } from "./bus";
import { decideInboxUpdate } from "./inbox-patch";

/** The view the cache is holding — every filter that changes what a page IS. */
export interface InboxFilters {
    statusFilter: Ref<string>;
    project: Ref<string | null>;
    onlyOpen: Ref<boolean>;
    showSnoozed: Ref<boolean>;
    priorityFilter: Ref<string>;
    sortBy: Ref<string>;
    page: Ref<number>;
    pageSize: Ref<number>;
}

export interface UseInboxCacheOpts {
    filters: InboxFilters;
    /** False while another view owns the screen (a thread, a search) — the
     *  cache then ignores live events instead of fetching for nobody. */
    enabled: Ref<boolean>;
}

/** The query the current filters describe, shared by the page read and the
 *  single-row read so the two can never disagree about what the view is. */
function queryFor(f: InboxFilters) {
    return {
        status: f.statusFilter.value === "all" || f.statusFilter.value === "unread"
            ? undefined
            : f.statusFilter.value,
        project: f.project.value ?? undefined,
        open: f.onlyOpen.value,
        include_postponed: f.showSnoozed.value,
        ...(f.priorityFilter.value !== "all" ? { priority: f.priorityFilter.value as Priority } : {}),
        ...(f.statusFilter.value === "unread" ? { unread: true } : {}),
    };
}

export function useInboxCache(opts: UseInboxCacheOpts) {
    const { filters, enabled } = opts;
    /** The page the server returned. Written HERE and nowhere else. */
    const rows = ref<InboxRow[]>([]);
    /** Rows matching the filters, all pages — the pager needs it, the page cannot say it. */
    const total = ref(0);

    /** Read the current page. Throws on failure so a caller can surface it. */
    async function fetchPage(): Promise<void> {
        const res = await api.inbox({
            ...queryFor(filters),
            sort: filters.sortBy.value,
            limit: filters.pageSize.value,
            offset: (filters.page.value - 1) * filters.pageSize.value,
        });
        rows.value = res.rows;
        total.value = res.total;
    }

    /** Drop everything — another view owns the screen. */
    function clear(): void {
        rows.value = [];
        total.value = 0;
    }

    /**
     * React to a live event: touch one row when only its content can have
     * moved, re-read the page when membership might have. `inbox-patch` holds
     * the rule and the reasoning behind the bias.
     */
    async function applyEvent(m: Message): Promise<void> {
        if (!enabled.value) return;
        const decision = decideInboxUpdate(m, { visible: new Set(rows.value.map((r) => r.id)) });
        if (decision.kind === "ignore") return;
        if (decision.kind === "refetch") { await fetchPage().catch(() => {}); return; }
        try {
            const { rows: fresh } = await api.inbox({ ...queryFor(filters), ids: [decision.ticketId] });
            const updated = fresh[0];
            if (!updated) {
                // The row no longer matches this view. Something from the next
                // page takes its place, and only the server knows what.
                await fetchPage();
                return;
            }
            const i = rows.value.findIndex((r) => r.id === updated.id);
            if (i >= 0) rows.value[i] = updated;
            else await fetchPage();
        } catch {
            // A patch that fails silently would leave a stale row on screen —
            // the exact failure this work exists to remove. Re-read instead.
            await fetchPage().catch(() => {});
        }
    }

    useBus("message.arrived", (m) => { void applyEvent(m); });
    useBus("message.decided", (m) => { void applyEvent(m); });
    // The blanket lane: something changed and nobody said what. Kept for the
    // callers that cannot be precise (bulk actions, snooze, a WS reconnect).
    useBus("inbox.refresh", () => { if (enabled.value) void fetchPage().catch(() => {}); });

    return { rows, total, fetchPage, clear };
}
