/**
 * #4874 — the board's trace of its switches: each time it changed master, from
 * which machine to which, when, by whom, at which revision. Written once, by the
 * new master, when the switch commits; a board table, so the nodes keep it too.
 */
import { desc } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb } from "./connection.js";

export interface MasterSwitch {
    id: number;
    from_machine: string;
    from_url: string;
    to_machine: string;
    to_url: string;
    rev: number;
    by: string | null;
    at: string;
}

export function recordSwitch(s: Omit<MasterSwitch, "id" | "at"> & { at?: string }): MasterSwitch {
    const row = getDb().insert(schema.masterSwitches).values({
        fromMachine: s.from_machine,
        fromUrl: s.from_url,
        toMachine: s.to_machine,
        toUrl: s.to_url,
        rev: s.rev,
        by: s.by,
        at: s.at ?? new Date().toISOString(),
    }).returning().get();
    return toView(row);
}

/** The latest switches, the most recent first. */
export function listSwitches(limit = 20): MasterSwitch[] {
    return getDb().select().from(schema.masterSwitches).orderBy(desc(schema.masterSwitches.id)).limit(limit).all().map(toView);
}

function toView(r: typeof schema.masterSwitches.$inferSelect): MasterSwitch {
    return { id: r.id, from_machine: r.fromMachine, from_url: r.fromUrl, to_machine: r.toMachine, to_url: r.toUrl, rev: r.rev, by: r.by, at: r.at };
}
