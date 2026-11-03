/**
 * #4689 — a ticket whose last word is a step waiting on another ticket stays in
 * the `working` band: its agent is on it. What it waits on is said beside it, in
 * the turn view's `waits_on`: the awaited ticket as the same caller sees it, its
 * band and its glyph, so a client can say "on it · waits on #3995 (escalation
 * to decide)". `null` when the row waits on nothing.
 */
import { getMessage, type Message } from "../db.js";
import { liveResumeOn } from "../db/wait-graph.js";
import { buildInboxRow, buildInboxRowContext } from "./inbox-row.js";
import { buildPilotFacts, pilotFields } from "./inbox-pilot.js";

export interface WaitsOn {
    id: number;
    title: string | null;
    band_name: string;
    state_glyph: string | null;
    closed: boolean;
}

/** `waits_on` for each row, read for `viewer`; rows not on a step are not looked at. */
export function waitsOnFor(rows: ReadonlyArray<{ id: number; latest_is_step?: boolean }>, viewer: string, viewerIsHuman: boolean): Map<number, WaitsOn | null> {
    const out = new Map<number, WaitsOn | null>();
    const awaitedBy = new Map<number, number>();
    for (const r of rows) {
        out.set(r.id, null);
        if (!r.latest_is_step) continue;
        const wait = liveResumeOn(r.id);
        if (wait) awaitedBy.set(r.id, wait.on);
    }
    const awaited = [...new Set(awaitedBy.values())].map((id) => getMessage(id)).filter((t): t is Message => !!t && t.kind === "ticket_created");
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
            seen.set(row.id, { id: row.id, title: row.title ?? null, band_name: p.band_name, state_glyph: p.state_glyph, closed: row.closed });
        }
    }
    for (const [waiter, on] of awaitedBy) out.set(waiter, seen.get(on) ?? null);
    return out;
}
