/**
 * #2640 — the wait credit.
 *
 * david: « les minutes qu'on attend sont prises sur un budget temps qu'on doit
 * gagner par preuve de travail ». Proof of work is what an agent cannot make
 * up by posting: a ticket closed on its accepted resolution or wontfix, and a
 * commit it posted (the diff is the currency).
 *
 * The balance is per agent x project: `tickets.wait_credit_start_minutes` plus
 * the movements. A step (`then: continue`) spends what it waits; the agent
 * coming back on the ticket before the end gets the rest back, which is what
 * makes looking early pay. Short of credit the wait is capped to the balance,
 * never below `tickets.step_min_wait_minutes` (david: « on peut mettre 5
 * minutes pour éviter le flood »), and that floor never takes the balance
 * below zero. `0` — carry on at once — is always granted and costs nothing.
 */
import { and, eq, sql } from "drizzle-orm";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as schema from "../schema.js";
import { getDb } from "./connection.js";
import { getConfig } from "./config-overrides.js";

export interface WaitGrant {
    requested: number;
    granted: number;
    /** What leaves the balance: never more than the balance itself. */
    spent: number;
}

/** Pure: what a step asking `requested` minutes gets from `balance`. */
export function grantWait(requested: number, balance: number, floor: number): WaitGrant {
    if (requested <= 0) return { requested, granted: 0, spent: 0 };
    const granted = requested <= floor ? requested : Math.max(Math.min(requested, balance), floor);
    return { requested, granted, spent: Math.min(granted, Math.max(balance, 0)) };
}

/** Pure: minutes given back when the agent returns `nowMs`, before `resumeAtMs`. */
export function refundWait(spent: number, resumeAtMs: number, nowMs: number): number {
    // Rounded up: the few milliseconds between the step and a check must not eat a minute.
    const left = Math.ceil((resumeAtMs - nowMs) / 60_000);
    return left > 0 ? Math.min(spent, left) : 0;
}

/** Pure: the credit a commit earns from its changed lines. */
export function commitMinutes(changedLines: number, linesPerMinute: number, maxPerCommit: number): number {
    if (!(changedLines > 0) || !(linesPerMinute > 0)) return 0;
    return Math.min(maxPerCommit, Math.floor(changedLines / linesPerMinute));
}

function num(key: string, project: string, fallback: number): number {
    const v = Number(getConfig(key, project) ?? fallback);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function waitCreditConfig(project: string) {
    return {
        start: num("tickets.wait_credit_start_minutes", project, 60),
        floor: num("tickets.step_min_wait_minutes", project, 5),
        resolved: num("tickets.wait_credit_resolved_minutes", project, 30),
        resolvedNoCommit: num("tickets.wait_credit_resolved_no_commit_minutes", project, 10),
        wontfix: num("tickets.wait_credit_wontfix_minutes", project, 5),
        linesPerMinute: num("tickets.wait_credit_commit_lines_per_minute", project, 20),
        maxPerCommit: num("tickets.wait_credit_commit_max_minutes", project, 30),
    };
}

export function waitCreditBalance(consumerId: string, project: string): number {
    const row = getDb().select({ total: sql<number>`COALESCE(SUM(${schema.waitCreditMoves.minutes}), 0)` })
        .from(schema.waitCreditMoves)
        .where(and(eq(schema.waitCreditMoves.consumerId, consumerId), eq(schema.waitCreditMoves.project, project)))
        .get();
    return waitCreditConfig(project).start + (row?.total ?? 0);
}

/** Insert a movement; a once-only guard turns a repeat into a no-op. Returns whether it landed. */
function record(move: Omit<schema.NewWaitCreditMove, "createdAt">): boolean {
    const r = getDb().run(sql`
        INSERT OR IGNORE INTO wait_credit_moves (consumer_id, project, kind, minutes, ticket_id, message_id, ref, requested, created_at)
        VALUES (${move.consumerId}, ${move.project}, ${move.kind}, ${move.minutes}, ${move.ticketId ?? null}, ${move.messageId ?? null}, ${move.ref ?? null}, ${move.requested ?? null}, ${new Date().toISOString()})
    `);
    return r.changes > 0;
}

/**
 * The agent is speaking on `ticketId` again: its latest step there, if still
 * waiting, gives back what is left. Called before the new message lands.
 */
export function refundOnReturn(consumerId: string, project: string, ticketId: number, nowMs = Date.now()): number {
    const step = getDb().all<{ message_id: number; spent: number; resume_at: string | null }>(sql`
        SELECT s.message_id, -s.minutes AS spent, json_extract(m.meta, '$.step_resume_at') AS resume_at
        FROM wait_credit_moves s
        JOIN _messages m ON m.id = s.message_id
        WHERE s.kind = 'spend' AND s.consumer_id = ${consumerId} AND s.project = ${project} AND s.ticket_id = ${ticketId}
        ORDER BY s.message_id DESC LIMIT 1
    `)[0];
    if (!step?.resume_at || step.spent <= 0) return 0;
    const minutes = refundWait(step.spent, Date.parse(step.resume_at), nowMs);
    if (minutes <= 0) return 0;
    return record({ consumerId, project, kind: "refund", minutes, ticketId, messageId: step.message_id }) ? minutes : 0;
}

/** What a step may wait, from the current balance. Nothing is recorded yet. */
export function planStepWait(consumerId: string, project: string, requested: number): WaitGrant & { balance: number } {
    const balance = waitCreditBalance(consumerId, project);
    return { ...grantWait(requested, balance, waitCreditConfig(project).floor), balance };
}

/** The step landed: record its spend. */
export function recordStepSpend(consumerId: string, project: string, ticketId: number, messageId: number, grant: WaitGrant): void {
    if (grant.spent <= 0) return;
    record({ consumerId, project, kind: "spend", minutes: -grant.spent, ticketId, messageId, requested: grant.requested });
}

/**
 * A ticket closed on the agent's accepted resolution (or wontfix). Once per
 * ticket. david: « une résolution sans commit ne redonne que 10 minutes » — a
 * resolution earns the full amount only when the agent cited a commit on that
 * ticket before it closed.
 */
export function earnOnClose(consumerId: string, project: string, ticketId: number, how: "resolved" | "wontfix"): number {
    const cfg = waitCreditConfig(project);
    const withCommit = getDb().all<{ n: number }>(sql`
        SELECT COUNT(*) AS n FROM wait_credit_moves
        WHERE kind = 'earn_commit' AND consumer_id = ${consumerId} AND ticket_id = ${ticketId}
    `)[0]?.n > 0;
    const minutes = how === "wontfix" ? cfg.wontfix : withCommit ? cfg.resolved : cfg.resolvedNoCommit;
    if (minutes <= 0) return 0;
    return record({ consumerId, project, kind: how === "resolved" ? "earn_resolved" : "earn_wontfix", minutes, ticketId }) ? minutes : 0;
}

export interface CommitCredit {
    commit: string;
    minutes: number;
    /** Why nothing was earned, when nothing was. */
    reason: string | null;
}

/** How long ago a commit may be to still earn: the work has to be fresh. */
export const COMMIT_MAX_AGE_HOURS = 48;

/**
 * Commits the agent cites on a reply, read in the project checkout it runs in
 * (`consumers.cwd`). A SHA earns once, whoever cites it; a commit that cannot
 * be read here (a loop behind a proxy node, a typo, an old commit) earns
 * nothing, and says why.
 */
export function earnForCommits(
    consumerId: string,
    project: string,
    ticketId: number,
    cwd: string | null,
    commits: string[],
    nowMs = Date.now(),
): CommitCredit[] {
    const cfg = waitCreditConfig(project);
    return commits.map((c): CommitCredit => {
        const commit = c.trim();
        if (!/^[0-9a-f]{7,40}$/i.test(commit)) return { commit, minutes: 0, reason: "not a commit SHA" };
        if (!cwd || !existsSync(cwd)) return { commit, minutes: 0, reason: "the agent's checkout is not readable from the daemon" };
        const git = (args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000 });
        const full = git(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
        if (full.status !== 0) return { commit, minutes: 0, reason: "not a commit in the agent's checkout" };
        const sha = full.stdout.trim();
        const when = Number(git(["show", "-s", "--format=%ct", sha]).stdout.trim()) * 1000;
        if (!(when > 0) || nowMs - when > COMMIT_MAX_AGE_HOURS * 3_600_000) {
            return { commit, minutes: 0, reason: `older than ${COMMIT_MAX_AGE_HOURS} h` };
        }
        const stat = git(["show", "--numstat", "--format=", sha]);
        let lines = 0;
        for (const row of stat.stdout.split("\n")) {
            const [a, d] = row.split("\t");
            if (/^\d+$/.test(a ?? "") && /^\d+$/.test(d ?? "")) lines += Number(a) + Number(d);
        }
        const minutes = commitMinutes(lines, cfg.linesPerMinute, cfg.maxPerCommit);
        if (minutes <= 0) return { commit, minutes: 0, reason: `${lines} changed lines: under ${cfg.linesPerMinute}` };
        return record({ consumerId, project, kind: "earn_commit", minutes, ticketId, ref: sha })
            ? { commit, minutes, reason: null }
            : { commit, minutes: 0, reason: "this commit was already counted" };
    });
}

export interface WaitCreditRow {
    consumer_id: string;
    project: string;
    balance: number;
    earned: number;
    spent: number;
    refunded: number;
}

/** Every agent x project that has a movement, with its balance. */
export function listWaitCredits(project: string | null = null): WaitCreditRow[] {
    const rows = getDb().all<{ consumer_id: string; project: string; earned: number; spent: number; refunded: number; total: number }>(sql`
        SELECT consumer_id, project,
            SUM(CASE WHEN kind LIKE 'earn_%' THEN minutes ELSE 0 END) AS earned,
            -SUM(CASE WHEN kind = 'spend' THEN minutes ELSE 0 END) AS spent,
            SUM(CASE WHEN kind = 'refund' THEN minutes ELSE 0 END) AS refunded,
            SUM(minutes) AS total
        FROM wait_credit_moves
        WHERE (${project} IS NULL OR project = ${project})
        GROUP BY consumer_id, project
        ORDER BY project, consumer_id
    `);
    return rows.map((r) => ({
        consumer_id: r.consumer_id,
        project: r.project,
        balance: waitCreditConfig(r.project).start + r.total,
        earned: r.earned,
        spent: r.spent,
        refunded: r.refunded,
    }));
}

export interface WaitCreditMoveRow {
    id: number;
    project: string;
    kind: string;
    minutes: number;
    ticket_id: number | null;
    message_id: number | null;
    ref: string | null;
    requested: number | null;
    created_at: string;
}

/** #2645 — one agent's latest movements, newest first, for the consumer page. */
export function listWaitCreditMoves(consumerId: string, limit = 30): WaitCreditMoveRow[] {
    return getDb().all<WaitCreditMoveRow>(sql`
        SELECT id, project, kind, minutes, ticket_id, message_id, ref, requested, created_at
        FROM wait_credit_moves
        WHERE consumer_id = ${consumerId}
        ORDER BY id DESC
        LIMIT ${Math.max(1, Math.min(200, limit))}
    `);
}

export interface TrimmedStep {
    message_id: number;
    ticket_id: number;
    project: string;
    by_agent: string | null;
    from: string;
    to: string;
    refunded: number;
}

/**
 * #2645 david — « rabote tous les then:continue à dans 5 minutes »: every step
 * still waiting longer than `maxMinutes` from now resumes at now + maxMinutes.
 * Credit spent on the part cut off comes back as a refund. The caller
 * invalidates the caches for the returned tickets.
 */
export function trimStepWaits(maxMinutes: number, nowMs = Date.now()): TrimmedStep[] {
    const limit = new Date(nowMs + maxMinutes * 60_000).toISOString();
    const rows = getDb().all<{ id: number; ticket_id: number; project: string; by_agent: string | null; resume_at: string }>(sql`
        SELECT m.id, m.ticket_id, t.project, m.by_agent, json_extract(m.meta, '$.step_resume_at') AS resume_at
        FROM _messages m JOIN tickets t ON t.id = m.ticket_id
        WHERE json_extract(m.meta, '$.step') = 1
          AND json_extract(m.meta, '$.step_resume_at') > ${limit}
    `);
    return rows.map((r) => {
        getDb().run(sql`UPDATE _messages SET meta = json_set(meta, '$.step_resume_at', ${limit}) WHERE id = ${r.id}`);
        let refunded = 0;
        const spend = getDb().all<{ spent: number }>(sql`
            SELECT -minutes AS spent FROM wait_credit_moves WHERE kind = 'spend' AND message_id = ${r.id}
        `)[0];
        if (spend && r.by_agent) {
            const cut = Math.round((Date.parse(r.resume_at) - Date.parse(limit)) / 60_000);
            const minutes = Math.min(spend.spent, cut);
            if (minutes > 0 && record({ consumerId: r.by_agent, project: r.project, kind: "refund", minutes, ticketId: r.ticket_id, messageId: r.id })) {
                refunded = minutes;
            }
        }
        return { message_id: r.id, ticket_id: r.ticket_id, project: r.project, by_agent: r.by_agent, from: r.resume_at, to: limit, refunded };
    });
}
