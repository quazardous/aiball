// #1992 — reading the compiled graph. Two questions, because the measurements
// only ever justified two.
//
// The contract that shapes everything here: a finding is a CANDIDATE, never a
// verdict. Nothing in this module closes, proposes, or writes. It says "these
// deserve a look" and hands over the citation, because the one detector that
// tried to conclude on its own — spotting superseded decisions from reversal
// vocabulary — produced 548 confident answers that were mostly wrong. The line
// between the two is whether the claim is citable in one hop.

import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./connection.js";
import * as schema from "../schema.js";
import { getTicketStages, type TicketStage } from "./tickets.js";
import { listTypedRelationsForTicket } from "./messages.js";
import { ensureGraphFresh, MENTION_KIND, type FreshResult } from "./graph-compile.js";

/**
 * A pair named once is usually decoration ("comme dans #1628"); twice or more
 * is a link. Measured on the corpus: 5460 edges, of which 2733 reach 2.
 */
export const LINK_WEIGHT = 2;

/** A component bigger than this is a hairball, not a cluster — see `graphAudit`. */
const MAX_CLUSTER = 6;
/** …and one smaller than this is just a pair, which the other findings cover. */
const MIN_CLUSTER = 3;
/** A stale-open candidate needs enough dead neighbours to mean something. */
const MIN_STALE_NEIGHBOURS = 3;

const isClosed = (stage: TicketStage | undefined) => stage === "closed" || stage === "closed-resolved";

/** Who holds a ticket, if anyone. Undefined when it is genuinely unattended. */
function holderOf(t: { claimant: string | null; assignee: string | null }):
    { claimant?: string; assignee?: string } | undefined {
    if (t.claimant) return { claimant: t.claimant };
    if (t.assignee) return { assignee: t.assignee };
    return undefined;
}

interface EdgeRow {
    src: number;
    dst: number;
    weight: number;
    messageId: number | null;
    offset: number;
}

function loadEdges(minWeight: number): EdgeRow[] {
    return getDb().all<{
        src_ticket_id: number; dst_ticket_id: number; weight: number;
        derived_message_id: number | null; derived_offset: number;
    }>(sql`
        SELECT src_ticket_id, dst_ticket_id, weight, derived_message_id, derived_offset
        FROM graph_edges WHERE kind = ${MENTION_KIND} AND weight >= ${minWeight}
    `).map((r) => ({
        src: r.src_ticket_id,
        dst: r.dst_ticket_id,
        weight: r.weight,
        messageId: r.derived_message_id,
        offset: r.derived_offset,
    }));
}

/** Where an edge came from, so a reader can go check rather than trust. */
export interface Citation {
    /** The comment it was read from; null when it came from the ticket's body. */
    message_id: number | null;
    /** Offset of the `#` in that text. */
    offset: number;
}

export interface NeighborRow {
    ticket_id: number;
    project: string;
    title: string;
    stage: TicketStage | null;
    /** "out" = this ticket names it; "in" = it names this ticket. */
    direction: "out" | "in" | "both";
    /** How many times the pair is named, both directions summed. */
    weight: number;
    citation: Citation | null;
    /** True when the neighbour lives in another project — invisible until now. */
    foreign_project: boolean;
    /** Present when a typed relation ALSO exists, so the two views can be compared. */
    typed_kind?: string;
}

export interface NeighborsResult {
    ticket_id: number;
    project: string | null;
    neighbors: NeighborRow[];
    freshness: FreshResult;
}

/**
 * What to read before touching a ticket. One hop only: two hops on this corpus
 * pulls in most of the board, and a list nobody finishes reading is the same as
 * no list.
 */
export function ticketNeighbors(
    ticketId: number,
    opts: { minWeight?: number; limit?: number } = {},
): NeighborsResult {
    const db = getDb();
    const freshness = ensureGraphFresh(db);
    const minWeight = opts.minWeight ?? 1;

    const rows = db.all<{
        src_ticket_id: number; dst_ticket_id: number; weight: number;
        derived_message_id: number | null; derived_offset: number;
    }>(sql`
        SELECT src_ticket_id, dst_ticket_id, weight, derived_message_id, derived_offset
        FROM graph_edges
        WHERE kind = ${MENTION_KIND} AND weight >= ${minWeight}
          AND (src_ticket_id = ${ticketId} OR dst_ticket_id = ${ticketId})
    `);

    const acc = new Map<number, NeighborRow>();
    for (const r of rows) {
        const out = r.src_ticket_id === ticketId;
        const other = out ? r.dst_ticket_id : r.src_ticket_id;
        const seen = acc.get(other);
        if (seen) {
            seen.weight += r.weight;
            if (seen.direction !== (out ? "out" : "in")) seen.direction = "both";
            // Keep the citation we already have: the first one found is as good
            // as any, and a reader only needs one door into the thread.
            continue;
        }
        acc.set(other, {
            ticket_id: other,
            project: "",
            title: "",
            stage: null,
            direction: out ? "out" : "in",
            weight: r.weight,
            citation: { message_id: r.derived_message_id, offset: r.derived_offset },
            foreign_project: false,
        });
    }

    const ids = [...acc.keys(), ticketId];
    const meta = new Map<number, { project: string; title: string }>();
    if (ids.length) {
        for (const t of db.select({
            id: schema.tickets.id,
            project: schema.tickets.project,
            title: schema.tickets.title,
        }).from(schema.tickets).where(inArray(schema.tickets.id, ids)).all()) {
            meta.set(t.id, { project: t.project, title: t.title ?? "" });
        }
    }
    const self = meta.get(ticketId) ?? null;
    const stages = getTicketStages([...acc.keys()]);
    // The typed view, for comparison rather than for filtering: showing both is
    // what makes "written about but never linked" visible at a glance.
    const typed = new Map<number, string>();
    for (const rel of listTypedRelationsForTicket(ticketId)) {
        typed.set(rel.target_ticket_id, rel.kind);
    }

    const neighbors = [...acc.values()].map((n) => {
        const m = meta.get(n.ticket_id);
        const kind = typed.get(n.ticket_id);
        return {
            ...n,
            project: m?.project ?? "",
            title: m?.title ?? "",
            stage: stages.get(n.ticket_id) ?? null,
            foreign_project: !!self && !!m && m.project !== self.project,
            ...(kind ? { typed_kind: kind } : {}),
        };
    }).sort((a, b) => b.weight - a.weight);

    return {
        ticket_id: ticketId,
        project: self?.project ?? null,
        neighbors: opts.limit ? neighbors.slice(0, opts.limit) : neighbors,
        freshness,
    };
}

export type FindingKind =
    /** Open, but every ticket it is written about is closed — its cohort left without it. */
    | "stale_open"
    /** Open child under a closed parent. */
    | "orphan_child"
    /** Two open tickets in different projects that write about each other, with no typed link. */
    | "cross_project_open_pair"
    /** A small knot of open tickets that are all about one thing. */
    | "root_cause_cluster";

export interface Finding {
    kind: FindingKind;
    ticket_ids: number[];
    /** One line a human can act on without opening anything. */
    detail: string;
    citation: Citation | null;
    /**
     * Who already holds the ticket, when someone does. Reported rather than
     * filtered on, and that choice comes from the first real run: all six
     * `stale_open` candidates on this project turned out to be held — five
     * claimed by the agent itself, one assigned to a machine that had been
     * offline for weeks. Dropping them would have destroyed the most useful
     * reading ("you have been sitting on this and its cohort left"); saying
     * nothing let it be mistaken for "nobody noticed". So it says which.
     */
    held_by?: { claimant?: string; assignee?: string };
}

export interface AuditResult {
    findings: Finding[];
    freshness: FreshResult;
    /** Open tickets considered, so an empty result reads as "clean", not "broken". */
    scanned: number;
}

/**
 * The hygiene report. Everything here is a candidate: it closes nothing,
 * proposes nothing, and never feeds a wake on its own — that would be a
 * behaviour rule, and this is an indicator.
 */
export function graphAudit(opts: { project?: string; limit?: number } = {}): AuditResult {
    const db = getDb();
    const freshness = ensureGraphFresh(db);

    const openRows = db.select({
        id: schema.tickets.id,
        project: schema.tickets.project,
        title: schema.tickets.title,
        claimant: schema.tickets.claimant,
        assignee: schema.tickets.assignee,
    }).from(schema.tickets)
        .where(opts.project
            ? and(eq(schema.tickets.status, "approved"), eq(schema.tickets.project, opts.project))
            : eq(schema.tickets.status, "approved"))
        .all();
    const allStages = getTicketStages(openRows.map((r) => r.id));
    const open = openRows.filter((r) => !isClosed(allStages.get(r.id)) && allStages.get(r.id) !== "rejected");
    const openIds = new Set(open.map((r) => r.id));
    const projectOf = new Map(openRows.map((r) => [r.id, r.project] as const));
    const titleOf = new Map(openRows.map((r) => [r.id, r.title ?? ""] as const));

    const edges = loadEdges(LINK_WEIGHT);
    // Undirected adjacency: for "what is this about", who wrote first is noise.
    const adj = new Map<number, Map<number, Citation>>();
    const link = (a: number, b: number, c: Citation) => {
        if (!adj.has(a)) adj.set(a, new Map());
        if (!adj.get(a)!.has(b)) adj.get(a)!.set(b, c);
    };
    for (const e of edges) {
        const c: Citation = { message_id: e.messageId, offset: e.offset };
        link(e.src, e.dst, c);
        link(e.dst, e.src, c);
    }
    const neighbourStages = getTicketStages([...new Set(edges.flatMap((e) => [e.src, e.dst]))]);

    const findings: Finding[] = [];

    // 1 — open, but everything it is written about is closed.
    for (const t of open) {
        const nb = adj.get(t.id);
        if (!nb || nb.size < MIN_STALE_NEIGHBOURS) continue;
        const dead = [...nb.keys()].every((n) => isClosed(neighbourStages.get(n)));
        if (!dead) continue;
        const held = holderOf(t);
        findings.push({
            kind: "stale_open",
            ticket_ids: [t.id],
            detail: `open, but all ${nb.size} tickets it names repeatedly are closed`
                + (held
                    ? ` — held by ${held.claimant ?? held.assignee}, so it is parked rather than forgotten`
                    : " — its cohort left without it, and nobody is holding it"),
            citation: [...nb.values()][0] ?? null,
            ...(held ? { held_by: held } : {}),
        });
    }

    // 2 — open child under a closed parent. Typed relations are the authority
    // here, so we ask the canonical replay per ticket rather than re-deriving
    // its last-wins semantics a second time.
    const childOf: Array<[number, number]> = [];
    for (const t of open) {
        for (const rel of listTypedRelationsForTicket(t.id)) {
            if (rel.kind === "child_of") childOf.push([t.id, rel.target_ticket_id]);
        }
    }
    const parentStages = getTicketStages([...new Set(childOf.map(([, p]) => p))]);
    for (const [child, parent] of childOf) {
        if (!isClosed(parentStages.get(parent))) continue;
        findings.push({
            kind: "orphan_child",
            ticket_ids: [child, parent],
            detail: `still open under #${parent}, which is closed`,
            citation: null,
        });
    }

    // 3 — two OPEN tickets in different projects writing about each other, with
    // no typed relation to make it visible anywhere in the UI.
    const seenPair = new Set<string>();
    for (const t of open) {
        const nb = adj.get(t.id);
        if (!nb) continue;
        const typed = new Set(listTypedRelationsForTicket(t.id).map((r) => r.target_ticket_id));
        for (const [other, cite] of nb) {
            if (!openIds.has(other)) continue;
            if (projectOf.get(other) === projectOf.get(t.id)) continue;
            if (typed.has(other)) continue;
            const key = `${Math.min(t.id, other)}:${Math.max(t.id, other)}`;
            if (seenPair.has(key)) continue;
            seenPair.add(key);
            findings.push({
                kind: "cross_project_open_pair",
                ticket_ids: [t.id, other],
                detail: `both open, in ${projectOf.get(t.id)} and ${projectOf.get(other)}, `
                    + `writing about each other with no typed relation`,
                citation: cite,
            });
        }
    }

    // 4 — small knots of open tickets. Bounded on purpose: on the raw graph the
    // largest component is 153 open tickets across 14 projects, which is a
    // hairball and tells nobody anything. A finding one cannot read is not one.
    const visited = new Set<number>();
    for (const t of open) {
        if (visited.has(t.id)) continue;
        const comp: number[] = [];
        const stack = [t.id];
        while (stack.length) {
            const n = stack.pop()!;
            if (visited.has(n) || !openIds.has(n)) continue;
            visited.add(n);
            comp.push(n);
            for (const nb of adj.get(n)?.keys() ?? []) if (!visited.has(nb)) stack.push(nb);
        }
        if (comp.length < MIN_CLUSTER || comp.length > MAX_CLUSTER) continue;
        const projects = [...new Set(comp.map((id) => projectOf.get(id)))].filter(Boolean);
        findings.push({
            kind: "root_cause_cluster",
            ticket_ids: comp.sort((a, b) => a - b),
            detail: `${comp.length} open tickets that write about each other`
                + (projects.length > 1 ? `, spanning ${projects.join(" + ")}` : "")
                + ` — likely one investigation: ${comp.map((id) => titleOf.get(id) ?? "").filter(Boolean)[0] ?? ""}`,
            citation: adj.get(comp[0])?.values().next().value ?? null,
        });
    }

    return {
        findings: opts.limit ? findings.slice(0, opts.limit) : findings,
        freshness,
        scanned: open.length,
    };
}
