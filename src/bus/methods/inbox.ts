/** #3063 — the inbox: the board's ticket rows, filtered, sorted and paged. */
import { z } from "zod";
import { consumerIdOf, defineMethod } from "../methods.js";
import { flag } from "../params.js";
import { isHuman, listMessages, ticketUnreadFlags, type MessageStatus } from "../../db.js";
import { emptyAgg, getInboxAgg } from "../../db/inbox-agg.js";
import { buildInboxRow, buildInboxRowContext, inboxRowCheap } from "../../api/inbox-row.js";
import { buildPilotFacts, pilotFields } from "../../api/inbox-pilot.js";
import { PRIORITY_WEIGHT } from "../../api/tickets.js";

/**
 * The board's ticket rows for the caller (docs/API-INBOX.md), with `total`
 * before paging. `view: "turn"` adds the pilot's fields (#3005 / #3038);
 * `ids` narrows to named tickets (#2072): an empty answer means they no
 * longer belong in this view. Read state, unread and the pilot's fields are
 * the caller's.
 */
defineMethod({
    name: "inbox.list",
    who: ["human", "agent"],
    params: z.object({
        project: z.string().optional(),
        status: z.string().optional(),
        open: flag,
        intent: z.string().optional(),
        priority: z.string().optional(),
        include_postponed: flag,
        ids: z.union([z.string(), z.array(z.number().int())]).optional(),
        sort: z.string().optional(),
        limit: z.coerce.number().optional(),
        offset: z.coerce.number().optional(),
        unread: flag,
        view: z.string().optional(),
    }),
    run: (caller, p) => {
    const project = p.project;
    const status = p.status as MessageStatus | undefined;
    const onlyOpen = p.open === true;
    const intentFilter = p.intent;
    // #B.222: optional priority filter — accepts a single value (low /
    // normal / high / urgent) and narrows the list to tickets whose
    // priority matches. "all" or absent = no filter.
    const priorityFilter = p.priority;
    // Include snoozed tickets in the open-inbox view (per #B.329). The
    // toggle in the header flips this on so a moderator can see what's
    // currently set aside. Default off — snoozed rows are hidden the
    // same way closed ones are.
    const includePostponed = p.include_postponed === true;
    // Read state is per-consumer — resolved from the X-Aiball-Consumer
    // header (UI sets this once globally) with AIBALL_HUMAN fallback.
    // Each row gets an `unread` boolean computed from the pings table
    // (≥1 unseen ping on the thread for that consumer).
    const consumerId = consumerIdOf(caller);

    let tickets = listMessages({ kind: "ticket_created", project });
    // #2072 — `ids` narrows to specific tickets so a client can refresh ONE row
    // instead of a page. Every other filter still applies, and that is the
    // useful part: an empty answer means "this ticket no longer belongs in this
    // view", which is exactly what a cache needs to hear to drop the row.
    // Paging is skipped for an id query — the caller already named the set.
    const idsParam = Array.isArray(p.ids) ? p.ids.join(",") : typeof p.ids === "string" ? p.ids : "";
    const wantedIds = idsParam
        ? new Set(idsParam.split(",").map((n) => Number(n.trim())).filter(Number.isSafeInteger))
        : null;
    if (wantedIds) tickets = tickets.filter((t) => wantedIds.has(t.id));
    const sortBy = p.sort ?? "activity";
    // #2071 — sort server-side, in the order the board displays. Paging in any
    // other order makes rows insert themselves above the one being read, which
    // is why loading "smallest project first" was the wrong idea however much
    // faster each chunk arrived (david `x3k3pr`). The three orders mirror the
    // client's own; `activity` stays the default the API always had. Rows and
    // the cheap fields below share these keys, so one comparator serves both.
    type SortKeys = { created_at: string; last_activity: string; priority: string | null };
    const compare = (a: SortKeys, b: SortKeys): number => {
        if (sortBy === "created_desc") return b.created_at.localeCompare(a.created_at);
        if (sortBy === "created_asc") return a.created_at.localeCompare(b.created_at);
        if (sortBy === "priority") {
            const w = (p: string | null | undefined) => PRIORITY_WEIGHT[p ?? "normal"] ?? 2;
            const d = w(b.priority) - w(a.priority);
            return d !== 0 ? d : b.created_at.localeCompare(a.created_at);
        }
        return b.last_activity.localeCompare(a.last_activity);
    };
    const limit = wantedIds ? NaN : Number(p.limit);
    const paged = Number.isFinite(limit) && limit > 0;
    const offset = paged ? Math.max(0, Number(p.offset) || 0) : 0;

    // #3000 — filter, and when the order allows it page, on the fields a row
    // takes from its ticket and aggregate alone, BEFORE building any row:
    // building one per ticket of the board, closed ones included, to keep 25
    // was most of the cost of the web board's list. The row filters below
    // still run, so the answer is the one the list always gave.
    const cheapNow = new Date().toISOString();
    const aggs = getInboxAgg(project);
    const cheapOf = new Map(tickets.map((t) => [t.id, inboxRowCheap(t, aggs.get(t.id) ?? emptyAgg(), cheapNow)]));
    tickets = tickets.filter((t) => {
        const c = cheapOf.get(t.id)!;
        if (status === "pending" && !(c.status === "pending" || c.pending_comment_count > 0)) return false;
        if ((status === "approved" || status === "rejected") && c.status !== status) return false;
        if (onlyOpen && c.closed) return false;
        if (!includePostponed && c.postponed) return false;
        if (intentFilter && intentFilter !== "all" && c.intent !== intentFilter) return false;
        if (priorityFilter && priorityFilter !== "all" && c.priority !== priorityFilter) return false;
        return true;
    });
    // Unread is per reader: one bounded read of the flags for the tickets left.
    if (p.unread === true) {
        const unread = ticketUnreadFlags(consumerId, tickets.map((t) => t.id));
        tickets = tickets.filter((t) => unread.get(t.id) === true);
    }
    // Band needs the built row: that order pages after it, as before.
    const pageEarly = paged && sortBy !== "band";
    let earlyTotal: number | null = null;
    if (pageEarly) {
        tickets.sort((a, b) => compare(cheapOf.get(a.id)!, cheapOf.get(b.id)!));
        earlyTotal = tickets.length;
        tickets = tickets.slice(offset, offset + limit);
    }

    // #2072 — the row is built by the shared builder, so a mutation that
    // returns "the updated object" returns exactly what the list holds.
    const rowCtx = buildInboxRowContext(tickets, consumerId, project);
    let rows = tickets.map((t) => buildInboxRow(t, rowCtx));

    if (status === "pending") {
        rows = rows.filter((r) => r.status === "pending" || r.pending_comment_count > 0);
    } else if (status === "approved" || status === "rejected") {
        rows = rows.filter((r) => r.status === status);
    }
    // #479 david : "dans la liste de tickets avec all on voit pas les pending".
    // Renverse la décision #450 (qui excluait les tickets pending du default
    // pour qu'ils ne pollutent pas le backlog). Avec "all" l'utilisateur
    // s'attend à voir EVERY ticket — pending inclus. "pending" reste le
    // sous-ensemble focalisé (pending tickets + approved tickets with
    // pending comments). "approved" / "rejected" inchangés.
    if (onlyOpen) {
        rows = rows.filter((r) => !r.closed);
    }
    // Snooze filter applies on every status combination — not just when
    // `open=1`. Otherwise pending+snoozed tickets slip through (regression
    // surfaced after #B.78 enabled snoozing on pending tickets).
    if (!includePostponed) {
        rows = rows.filter((r) => !r.postponed);
    }
    if (intentFilter && intentFilter !== "all") {
        rows = rows.filter((r) => r.intent === intentFilter);
    }
    if (priorityFilter && priorityFilter !== "all") {
        rows = rows.filter((r) => (r.priority ?? "normal") === priorityFilter);
    }

    // #2071 — the UNREAD filter, server-side. This is the one that unblocks
    // everything else: the client computed it from the per-row flag, and the
    // code said so where it paginated ("paginating before that filter would
    // yield ragged pages"), so the endpoint had to return the whole board.
    // The flag was already computed here; only the filter was missing.
    if (p.unread === true) {
        rows = rows.filter((r) => r.unread);
    }

    // #3005 — the pilot's fields (turn, band, state glyph), computed only when
    // asked: `view=turn` puts them on the rows, `sort=band` orders by them. Read
    // after filtering, so the gate runs on the rows that are returned.
    // #3038 — the view is named for what it adds, not for a client (it was
    // `v=tvty`); the row is documented in docs/API-INBOX.md.
    const withPilot = p.view === "turn";
    const pilot = withPilot || sortBy === "band"
        ? (() => {
            const facts = buildPilotFacts(rows, consumerId, project);
            const human = isHuman(consumerId);
            return new Map(rows.map((r) => [r.id, pilotFields(r, facts.get(r.id)!, consumerId, human)]));
        })()
        : null;
    if (sortBy === "band" && pilot) {
        rows.sort((a, b) => pilot.get(a.id)!.band - pilot.get(b.id)!.band
            || b.last_activity.localeCompare(a.last_activity));
    } else {
        rows.sort(compare);
    }

    // #2071 — page AFTER filtering and sorting, never before. The total goes in
    // a header rather than wrapping the body in an envelope: every existing
    // consumer keeps receiving a plain array, and the pager gets its count.
    //
    // The page SIZE comes from the caller (david `x3k3pr`): it is a user
    // preference kept in localStorage, so hardcoding 25 here would silently
    // ignore whatever the reader chose. No limit at all = the whole list,
    // which is what every non-UI consumer still asks for.
    const total = earlyTotal ?? rows.length;
    if (paged && !pageEarly) rows = rows.slice(offset, offset + limit);

    return { total, rows: withPilot && pilot ? rows.map((r) => ({ ...r, ...pilot.get(r.id)! })) : rows };
    },
});
