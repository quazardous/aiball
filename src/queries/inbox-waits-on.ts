/**
 * #4689 — a ticket whose last word is a step stays in the `working` band: its
 * agent is on it. What it waits on is said beside it, in the turn view's
 * `waits_on`: the awaited ticket as the same caller sees it, its band and its
 * glyph, so a client can say "on it · waits on #3995 (escalation to decide)".
 * The waits are those `graph_audit` reads (`waitsOf`): the step's own
 * `resume_on` while the ticket it names has not moved, else the first
 * `depends_on` still open (`kind` says which). `null` when it waits on nothing.
 */
import { getMessage, type Message } from "../db.js";
import { waitsOf, type WaitKind } from "../db/wait-graph.js";
import { buildInboxRow, buildInboxRowContext } from "./inbox-row.js";
import { buildPilotFacts, pilotFields } from "./inbox-pilot.js";

export interface WaitsOn {
    id: number;
    kind: WaitKind;
    title: string | null;
    band_name: string;
    state_glyph: string | null;
    closed: boolean;
}

/** `waits_on` for each row, read for `viewer`; rows not on a step are not looked at. */
export function waitsOnFor(rows: ReadonlyArray<{ id: number; latest_is_step?: boolean }>, viewer: string, viewerIsHuman: boolean): Map<number, WaitsOn | null> {
    const out = new Map<number, WaitsOn | null>();
    const awaitedBy = new Map<number, { on: number; kind: WaitKind }>();
    for (const r of rows) {
        out.set(r.id, null);
        if (!r.latest_is_step) continue;
        const waits = waitsOf(r.id);
        const wait = waits.find((w) => w.kind === "resume_on") ?? waits[0];
        if (wait) awaitedBy.set(r.id, { on: wait.on, kind: wait.kind });
    }
    const awaited = [...new Set([...awaitedBy.values()].map((w) => w.on))].map((id) => getMessage(id)).filter((t): t is Message => !!t && t.kind === "ticket_created");
    if (awaited.length === 0) return out;
    const seen = new Map<number, WaitsOn>();
    const byProject = new Map<string, Message[]>();
    for (const t of awaited) byProject.set(t.project, [...(byProject.get(t.project) ?? []), t]);
    for (const [project, tickets] of byProject) {
        const ctx = buildInboxRowContext(tickets, viewer, project);
        const built = tickets.map((t) => buildInboxRow(t, ctx));
        const facts = buildPilotFacts(built, viewer, project);
        for (const row of built) {
            const p = pilotFields(row, facts.get(row.id)!, viewer, viewerIsHuman);
            seen.set(row.id, { id: row.id, kind: "resume_on", title: row.title ?? null, band_name: p.band_name, state_glyph: p.state_glyph, closed: row.closed });
        }
    }
    for (const [waiter, w] of awaitedBy) {
        const it = seen.get(w.on);
        out.set(waiter, it ? { ...it, kind: w.kind } : null);
    }
    return out;
}
