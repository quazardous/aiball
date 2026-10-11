/**
 * #3760 — rename an agent: its id rewritten in every column that holds it,
 * history included, in one transaction (the way `renameProject` renames a
 * project). The history is rewritten rather than aliased: an agent's own past
 * comments, decisions and `last_actor` stay its own, so "you spoke last", its
 * pending decisions and the actionable gate keep working under the new name.
 *
 * Renaming onto an agent that already exists merges into it: the case of an
 * agent renamed by hand in `.aiball.yaml`, whose new name already posted while
 * its claims stayed on the old one. The new consumer's own record is kept; a
 * row that would duplicate one it has (a subscription, a ping) is dropped.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./connection.js";
import { clearFlagsCache } from "./flags-cache.js";
import { clearInboxAgg } from "./inbox-agg-cache.js";
import { invalidateFlagsCache } from "./projects.js";

/** Every column holding a consumer id, as `table.column` (SQL names). */
export const AGENT_ID_COLUMNS: ReadonlyArray<readonly [string, string]> = [
    ["consumers", "consumer_id"],
    ["tokens", "consumer_id"],
    ["subscriptions", "consumer_id"],
    ["ticket_subscriptions", "consumer_id"],
    ["pings", "recipient"],
    ["pings", "actor"],
    ["signals", "target_consumer"],
    ["signal_deliveries", "recipient"],
    ["backlog_wake_log", "consumer_id"],
    ["wait_credit_moves", "consumer_id"],
    ["tickets", "by_agent"],
    ["tickets", "assignee"],
    ["tickets", "assigned_by"],
    ["tickets", "claimant"],
    ["tickets", "decided_by"],
    ["tickets", "last_actor"],
    ["_messages", "by_agent"],
    ["_messages", "decided_by"],
    ["automation_rules", "match_by_agent"],
    ["automation_rules", "scope_consumer"],
    ["config_overrides", "updated_by"],
    ["idempotency_keys", "author"],
    ["projects", "created_by"],
    ["ticket_payloads", "by_agent"],
    ["ticket_payloads", "revoked_by"],
    ["ticket_tags", "set_by"],
    ["uploads", "by_agent"],
    ["node_enrollments", "decided_by"],
    ["node_revocations", "revoked_by"],
];

/** Where a merge may meet a row the new agent already has: the old one is the duplicate. */
const KEYED = new Set(["consumers.consumer_id", "subscriptions.consumer_id", "ticket_subscriptions.consumer_id", "pings.recipient"]);

export interface AgentRenameCounts {
    old_name: string;
    new_name: string;
    /** The new agent existed already: the old one was merged into it. */
    merged: boolean;
    /** Rows changed per `table.column`, only those with any. */
    rows: Record<string, number>;
}

export interface AgentRenameFacts {
    old: { exists: boolean; kind: string | null };
    new: { exists: boolean; kind: string | null };
    /** Rows that hold the old id, per `table.column`, only those with any. */
    rows: Record<string, number>;
}

function kindOf(id: string): string | null {
    const r = getDb().get<{ kind: string }>(sql`SELECT kind FROM consumers WHERE consumer_id = ${id}`);
    return r?.kind ?? null;
}

/** What a rename would change, read only. */
export function agentRenameFacts(oldId: string, newId: string): AgentRenameFacts {
    const rows: Record<string, number> = {};
    for (const [t, c] of AGENT_ID_COLUMNS) {
        const n = getDb().get<{ n: number }>(sql`SELECT count(*) AS n FROM ${sql.identifier(t)} WHERE ${sql.identifier(c)} = ${oldId}`)?.n ?? 0;
        if (n > 0) rows[`${t}.${c}`] = n;
    }
    const oldKind = kindOf(oldId);
    const newKind = kindOf(newId);
    return { old: { exists: oldKind !== null, kind: oldKind }, new: { exists: newKind !== null, kind: newKind }, rows };
}

/** Why a rename cannot go ahead, from its facts; empty when it can. */
export function agentRenameRefusals(oldId: string, newId: string, facts: AgentRenameFacts): string[] {
    const out: string[] = [];
    if (!oldId.trim() || !newId.trim()) out.push("the old and new names must not be empty");
    else if (oldId === newId) out.push("the old and new names are the same");
    if (/\s/.test(newId)) out.push(`"${newId}" must not contain whitespace`);
    if (!facts.old.exists) out.push(`agent "${oldId}" does not exist`);
    else if (facts.old.kind !== "agent") out.push(`"${oldId}" is a ${facts.old.kind}, not an agent`);
    if (facts.new.exists && facts.new.kind !== "agent") out.push(`"${newId}" exists and is a ${facts.new.kind}, not an agent`);
    return out;
}

export function renameAgent(oldId: string, newId: string): AgentRenameCounts {
    const db = getDb();
    const out = db.transaction((tx) => {
        const facts = agentRenameFacts(oldId, newId);
        const refusals = agentRenameRefusals(oldId, newId, facts);
        if (refusals.length > 0) throw new Error(`rename_agent: ${refusals.join("; ")}`);
        tx.run(sql`PRAGMA defer_foreign_keys = ON`);
        const rows: Record<string, number> = {};
        for (const [t, c] of AGENT_ID_COLUMNS) {
            const key = `${t}.${c}`;
            const changed = tx.run(sql`UPDATE OR IGNORE ${sql.identifier(t)} SET ${sql.identifier(c)} = ${newId} WHERE ${sql.identifier(c)} = ${oldId}`).changes;
            if (changed > 0) rows[key] = changed;
            const left = tx.get<{ n: number }>(sql`SELECT count(*) AS n FROM ${sql.identifier(t)} WHERE ${sql.identifier(c)} = ${oldId}`)?.n ?? 0;
            if (left === 0) continue;
            // Only a merge leaves rows behind, and only where the new agent has the same one.
            if (!KEYED.has(key)) throw new Error(`rename_agent: ${left} row(s) of ${key} could not be moved`);
            tx.run(sql`DELETE FROM ${sql.identifier(t)} WHERE ${sql.identifier(c)} = ${oldId}`);
        }
        return { old_name: oldId, new_name: newId, merged: facts.new.exists, rows };
    });
    // Every view that names an author, a holder or a recipient was built on the old id.
    clearFlagsCache();
    invalidateFlagsCache();
    clearInboxAgg();
    return out;
}
