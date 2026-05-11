/**
 * Moderation rules — first-match-wins pipeline that decides whether
 * a freshly-posted message is auto-approved or sent to human review.
 *
 * Extracted from db.ts (#B.332 Phase A.2). Pure CRUD; the evaluator
 * itself lives in `src/rules.ts`.
 */
import { asc, eq } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";
import type {
    MessageKind,
    NewRule,
    Rule,
    RuleDecision,
} from "./connection.js";

function ruleRowToRule(r: schema.Rule): Rule {
    return {
        id: r.id,
        position: r.position,
        match_project: r.matchProject,
        match_kind: (r.matchKind as MessageKind | null) ?? null,
        match_by_agent: r.matchByAgent,
        decision: r.decision as RuleDecision,
        enabled: r.enabled,
        note: r.note,
        created_at: r.createdAt,
    };
}

export function insertRule(r: NewRule): Rule {
    const db = getDb();
    const inserted = db.insert(schema.rules).values({
        position: r.position ?? 0,
        matchProject: r.match_project ?? null,
        matchKind: r.match_kind ?? null,
        matchByAgent: r.match_by_agent ?? null,
        decision: r.decision,
        enabled: 1,
        note: r.note ?? null,
        createdAt: nowIso(),
    }).returning().get();
    return ruleRowToRule(inserted);
}

export function listRules(opts: { enabledOnly?: boolean } = {}): Rule[] {
    const db = getDb();
    let q = db.select().from(schema.rules).$dynamic();
    if (opts.enabledOnly) q = q.where(eq(schema.rules.enabled, 1));
    return q.orderBy(asc(schema.rules.position), asc(schema.rules.id)).all().map(ruleRowToRule);
}

export function deleteRule(id: number): void {
    getDb().delete(schema.rules).where(eq(schema.rules.id, id)).run();
}

export function setRuleEnabled(id: number, enabled: boolean): Rule | null {
    const db = getDb();
    db.update(schema.rules).set({ enabled: enabled ? 1 : 0 })
        .where(eq(schema.rules.id, id)).run();
    const r = db.select().from(schema.rules).where(eq(schema.rules.id, id)).get();
    return r ? ruleRowToRule(r) : null;
}
