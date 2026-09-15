/**
 * #2276 — signal keys as a human manages them, and the signals a project received.
 *
 * A key is addressed by a non-secret handle (`key_id`), like a proxy node: the
 * token value is shown once, when the key is minted, and never again. Every key
 * carries a note saying who it was given to and why. Its label is the source of
 * every signal it posts, so two keys may not share a label — the Signals tab
 * could no longer tell whose signal was whose.
 */
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";
import { deleteToken, issueToken, tokenHandle } from "./tokens.js";
import { listProjectSubscribers } from "./subscriptions.js";

export const SIGNAL_KEY_LABEL_MAX = 100;
/**
 * #2526 — what a key may do. `signals`: POST /api/signals, what every key could
 * do before scopes existed. `tickets:create`: POST /api/tickets, creating
 * tickets already approved in the key's projects — moderation happens once, when
 * a human grants the scope, not ticket by ticket.
 */
export const API_KEY_SCOPES = ["signals", "tickets:create"] as const;
export type ApiKeyScope = typeof API_KEY_SCOPES[number];
export const SIGNAL_KEY_NOTE_MAX = 500;
export const PROJECT_SIGNALS_LIMIT = 200;

export interface SignalKeyView {
    key_id: string;
    label: string;
    note: string | null;
    created_at: string;
    last_used_at: string | null;
    /** Signals posted under this key's source, whatever their target. */
    signals_sent: number;
    /** Listed for a project only: how many of those reached it. */
    signals_to_project?: number;
    /** #2526 — what the key may do. */
    scopes: ApiKeyScope[];
    /** #2526 — the projects it may create tickets in (with `tickets:create`). */
    projects: string[];
}

export type SignalKeyError = { error: string; status: 400 | 404 | 409 };

function signalKeyRows(): schema.Token[] {
    return getDb().select().from(schema.tokens).where(eq(schema.tokens.kind, "signal")).all();
}

function findSignalKey(key_id: string): schema.Token | undefined {
    return signalKeyRows().find((r) => tokenHandle(r.token) === key_id);
}

/** The note is what says who holds the key: required, trimmed, bounded. */
export function parseSignalKeyNote(raw: unknown): string | SignalKeyError {
    if (typeof raw !== "string" || !raw.trim()) {
        return { error: "note is required: say who the key was given to and why", status: 400 };
    }
    const note = raw.trim();
    if (note.length > SIGNAL_KEY_NOTE_MAX) return { error: `note is limited to ${SIGNAL_KEY_NOTE_MAX} characters`, status: 400 };
    return note;
}

/**
 * Signals that concern a project: aimed at it, or aimed at one of its owners.
 * An agent owning two projects sees a signal aimed at it on both.
 */
function concernsProject(project: string): SQL {
    const owners = listProjectSubscribers(project, { roles: ["owner"] });
    const toProject = eq(schema.signals.targetProject, project);
    return owners.length ? or(toProject, inArray(schema.signals.targetConsumer, owners))! : toProject;
}

function countBySource(where?: SQL): Map<string, number> {
    const base = getDb()
        .select({ source: schema.signals.source, n: sql<number>`count(*)` })
        .from(schema.signals)
        .$dynamic();
    const rows = (where ? base.where(where) : base).groupBy(schema.signals.source).all();
    return new Map(rows.map((r) => [r.source, Number(r.n)]));
}

function readJsonList(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const j = JSON.parse(raw) as unknown;
        return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string") : [];
    } catch {
        return [];
    }
}

/** A key's scopes: stored, or `signals` for a key minted before scopes existed. */
export function keyScopes(r: { scopes?: string | null }): ApiKeyScope[] {
    if (r.scopes == null) return ["signals"];
    return readJsonList(r.scopes).filter((s): s is ApiKeyScope => (API_KEY_SCOPES as readonly string[]).includes(s));
}

export function keyProjects(r: { projects?: string | null }): string[] {
    return readJsonList(r.projects);
}

/**
 * Validate scopes and projects as a pair. Unknown scopes are refused, at least
 * one scope is required, and `tickets:create` needs at least one existing
 * project: a key that creates tickets anywhere is not something to hand out.
 */
export function parseKeyGrants(rawScopes: unknown, rawProjects: unknown): { scopes: ApiKeyScope[]; projects: string[] } | SignalKeyError {
    const scopes = rawScopes === undefined ? ["signals"] : rawScopes;
    if (!Array.isArray(scopes) || scopes.length === 0) return { error: "scopes must be a non-empty list", status: 400 };
    const unknown = scopes.filter((s) => !(API_KEY_SCOPES as readonly unknown[]).includes(s));
    if (unknown.length) return { error: `unknown scope ${unknown.map(String).join(", ")} — scopes are ${API_KEY_SCOPES.join(", ")}`, status: 400 };
    const projects = rawProjects === undefined ? [] : rawProjects;
    if (!Array.isArray(projects) || projects.some((p) => typeof p !== "string" || !p.trim())) {
        return { error: "projects must be a list of project names", status: 400 };
    }
    const names = [...new Set((projects as string[]).map((p) => p.trim()))];
    if (scopes.includes("tickets:create") && names.length === 0) {
        return { error: "tickets:create needs at least one project: say where the key may create tickets", status: 400 };
    }
    const existing = new Set(getDb().select({ name: schema.projects.name }).from(schema.projects).all().map((r) => r.name));
    const missing = names.filter((n) => !existing.has(n));
    if (missing.length) return { error: `no such project: ${missing.join(", ")}`, status: 400 };
    return { scopes: [...new Set(scopes as ApiKeyScope[])], projects: names };
}

function toView(r: schema.Token, sent: Map<string, number>, toProject: Map<string, number> | null): SignalKeyView {
    const label = r.label ?? "";
    return {
        key_id: tokenHandle(r.token),
        label,
        note: r.note ?? null,
        created_at: r.createdAt,
        last_used_at: r.lastUsedAt,
        signals_sent: sent.get(label) ?? 0,
        ...(toProject ? { signals_to_project: toProject.get(label) ?? 0 } : {}),
        scopes: keyScopes(r),
        projects: keyProjects(r),
    };
}

/** Every signal key — never its token. With a project, each key also counts what reached it. */
export function listSignalKeys(project?: string): SignalKeyView[] {
    const sent = countBySource();
    const toProject = project ? countBySource(concernsProject(project)) : null;
    return signalKeyRows().map((r) => toView(r, sent, toProject));
}

/** Mint a key. The token comes back here and nowhere else. */
export function issueSignalKey(
    rawLabel: unknown,
    rawNote: unknown,
    rawScopes?: unknown,
    rawProjects?: unknown,
): { key: SignalKeyView; token: string } | SignalKeyError {
    if (typeof rawLabel !== "string" || !rawLabel.trim()) {
        return { error: "label is required: it names the system posting signals", status: 400 };
    }
    const label = rawLabel.trim();
    if (label.length > SIGNAL_KEY_LABEL_MAX) return { error: `label is limited to ${SIGNAL_KEY_LABEL_MAX} characters`, status: 400 };
    const note = parseSignalKeyNote(rawNote);
    if (typeof note !== "string") return note;
    const grants = parseKeyGrants(rawScopes, rawProjects);
    if ("error" in grants) return grants;
    if (signalKeyRows().some((r) => r.label === label)) {
        return {
            error: `a signal key labelled '${label}' already exists — the label is the source of every signal it posts, so revoke that key or pick another label`,
            status: 409,
        };
    }
    const t = issueToken({
        consumer_id: null, kind: "signal", label, note,
        scopes: JSON.stringify(grants.scopes),
        projects: JSON.stringify(grants.projects),
    });
    const row = signalKeyRows().find((r) => r.token === t.token)!;
    return { key: toView(row, countBySource(), null), token: t.token };
}

export function updateSignalKeyNote(key_id: string, rawNote: unknown): SignalKeyView | SignalKeyError {
    return updateSignalKey(key_id, { note: rawNote });
}

/** #2526 — edit a key's note, scopes and projects; only the fields given change. */
export function updateSignalKey(
    key_id: string,
    patch: { note?: unknown; scopes?: unknown; projects?: unknown },
): SignalKeyView | SignalKeyError {
    const row = findSignalKey(key_id);
    if (!row) return { error: "no signal key with this id", status: 404 };
    const set: Partial<typeof schema.tokens.$inferInsert> = {};
    if (patch.note !== undefined) {
        const note = parseSignalKeyNote(patch.note);
        if (typeof note !== "string") return note;
        set.note = note;
    }
    if (patch.scopes !== undefined || patch.projects !== undefined) {
        const grants = parseKeyGrants(
            patch.scopes !== undefined ? patch.scopes : keyScopes(row),
            patch.projects !== undefined ? patch.projects : keyProjects(row),
        );
        if ("error" in grants) return grants;
        set.scopes = JSON.stringify(grants.scopes);
        set.projects = JSON.stringify(grants.projects);
    }
    if (Object.keys(set).length === 0) return toView(row, countBySource(), null);
    getDb().update(schema.tokens).set(set).where(eq(schema.tokens.token, row.token)).run();
    return toView({ ...row, ...set } as schema.Token, countBySource(), null);
}

/** Revoke = the token row is deleted. The signals it posted stay, under its source. */
export function revokeSignalKey(key_id: string): boolean {
    const row = findSignalKey(key_id);
    return row ? deleteToken(row.token) : false;
}

export type DeliveryState = "delivered" | "pending" | "expired";

export interface ProjectSignalView {
    id: number;
    source: string;
    target_consumer: string | null;
    target_project: string | null;
    target_level: string | null;
    title: string;
    body: string | null;
    severity: "normal" | "panic";
    repeat_count: number;
    created_at: string;
    updated_at: string;
    expires_at: string;
    deliveries: { recipient: string; state: DeliveryState; acked_at: string | null }[];
}

/** The signals that concern a project, newest first, with each recipient's delivery state. */
export function listProjectSignals(project: string, now: string = nowIso(), limit = PROJECT_SIGNALS_LIMIT): ProjectSignalView[] {
    const db = getDb();
    const rows = db.select().from(schema.signals)
        .where(concernsProject(project))
        .orderBy(desc(schema.signals.id))
        .limit(limit)
        .all();
    if (rows.length === 0) return [];
    const deliveries = db.select().from(schema.signalDeliveries)
        .where(and(inArray(schema.signalDeliveries.signalId, rows.map((r) => r.id))))
        .all();
    return rows.map((r) => ({
        id: r.id,
        source: r.source,
        target_consumer: r.targetConsumer,
        target_project: r.targetProject,
        target_level: r.targetLevel,
        title: r.title,
        body: r.body,
        severity: r.severity === "panic" ? "panic" : "normal",
        repeat_count: r.repeatCount,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
        expires_at: r.expiresAt,
        deliveries: deliveries
            .filter((d) => d.signalId === r.id)
            .map((d) => ({
                recipient: d.recipient,
                acked_at: d.ackedAt,
                state: d.ackedAt ? "delivered" : r.expiresAt <= now ? "expired" : "pending",
            })),
    }));
}
