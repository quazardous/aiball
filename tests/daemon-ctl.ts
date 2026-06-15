// #984 (#981 Slice 3, daemon layer) — daemon-side control for the full-stack
// orchestrator. Runs INSIDE the daemon container (localhost:7777 + shared DB),
// driven by run_fullstack.py via `docker compose exec daemon`. Three subcommands,
// each prints a single JSON line on stdout :
//
//   seed <fixture>   → build a named fixture, print its handles {ticket, decision, …}
//   mutate '<json>'  → {action, …} : accept_decision {decision} | ticket_reply {ticket, body}
//   query <path>     → resolve a daemon-state dotted value : ticket.<id>.ping_rows |
//                      ticket.<id>.closed | ticket.<id>.comments
//
// Mutations go through the REAL business API (the same routes the web UI hits),
// so e.g. accept_decision exercises /accept-and-close incl. its skipFanOut.
// Queries read the DB directly (the assertion layer needs ground truth, e.g.
// the exact ping-row count for the #980 regression).
import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "../src/db.js";
import { createProject, listProjects } from "../src/db/projects.js";
import * as schema from "../src/schema.js";
import { BASE, provision, provisionHuman, post, decide, seedCounters } from "./lib.js";

const PROJECT = "bidon";

/** The business API rejects posts to an unregistered project. The agent loop
 *  registers `bidon` at boot, but the fixture seeds BEFORE the loop is ready —
 *  so ensure it here (idempotent). */
function ensureProject(name: string): void {
    if (!listProjects().includes(name)) createProject({ name });
}

// ---- fixtures : named initial data sets (timeline 3) -------------------------
async function seed(name: string): Promise<Record<string, unknown>> {
    if (name === "resolution-pending") {
        // A ticket reported by the HUMAN (so the human can accept-and-close),
        // with a resolution decision proposed by an AGENT (pending).
        seedCounters();
        ensureProject(PROJECT);
        const human = provisionHuman("fixture-human");
        const agent = provision("fixture-agent");
        const ticket = await post(human, {
            project: PROJECT, kind: "ticket_created",
            title: "fixture: resolution-pending", by_agent: "fixture-human",
        });
        const ticketId = (ticket.ticket_id ?? ticket.id) as number;
        const decision = await post(agent, {
            project: PROJECT, kind: "comment_added", ticket_id: ticketId,
            body: "done — proposing resolution", by_agent: "fixture-agent",
            summary_until: "resolution proposed; awaiting human accept",
            decision_kind: "resolution",
        });
        return { ticket: ticketId, decision: decision.id as number };
    }
    if (name === "mention-unread") {
        // Golden-path seed (#985) : a ticket by another agent that @mentions the
        // loop's consumer (test-agent) → forces an unread ping to it. The loop
        // then wakes on that unread and, on wake delivery, marks it seen — so a
        // post-wake `unread.test-agent` query drops to 0 (full stack exercised).
        seedCounters();
        ensureProject(PROJECT);
        provision("test-agent");           // ensure the loop's consumer exists so the @mention resolves
        const reporter = provision("reporter");
        const ticket = await post(reporter, {
            project: PROJECT, kind: "ticket_created",
            title: "fixture: golden path", by_agent: "reporter",
            body: "@test-agent please handle the golden path",
        });
        return { ticket: (ticket.ticket_id ?? ticket.id) as number };
    }
    throw new Error(`unknown fixture '${name}'`);
}

// ---- mutations : in-run data-plane changes ----------------------------------
async function mutate(spec: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = Object.keys(spec)[0];
    const args = (spec[action] ?? {}) as Record<string, unknown>;
    if (action === "accept_decision") {
        // The human reporter accepts the decision-on-comment via /decide (flips
        // meta.decision → accepted). NOTE: /accept-and-close 400s on a decision-
        // on-comment (it's moderation-approved, not pending) — the full-stack
        // harness surfaced that the #980 interim frontend fix is unsound ; the
        // proper fix is /decide auto-closing a resolution server-side (the
        // accepted #980 plan). Once that lands, this same step will also close
        // the ticket + skipFanOut → the regression scenario's closed/ping_rows
        // assertions flip green.
        const human = provisionHuman("fixture-human");
        return decide(human, Number(args.decision), "accepted");
    }
    if (action === "ticket_reply") {
        const agent = provision("fixture-agent");
        return post(agent, {
            project: PROJECT, kind: "comment_added", ticket_id: Number(args.ticket),
            body: String(args.body ?? "reply"), by_agent: "fixture-agent",
            summary_until: String(args.summary_until ?? "agent replied"),
        });
    }
    throw new Error(`unknown mutate action '${action}'`);
}

// ---- queries : ground-truth daemon state for assertions ---------------------
function query(path: string): unknown {
    const parts = path.split(".");
    if (parts[0] === "ticket") {
        const id = Number(parts[1]);
        const field = parts.slice(2).join(".");
        const db = getDb();
        if (field === "ping_rows") {
            // Lifecycle-on-ticket ping rows (ticket_closed/resolved/reopened use
            // ticketId ; comment pings use commentId). #980 : after accept-and-
            // close, the auto ticket_closed is skipFanOut → expect 0 here.
            const rows = db.select().from(schema.pings).where(eq(schema.pings.ticketId, id)).all();
            return rows.length;
        }
        if (field === "closed") {
            const m = db.select().from(schema.messages)
                .where(and(eq(schema.messages.ticketId, id), eq(schema.messages.kind, "ticket_closed")))
                .all();
            return m.length > 0;
        }
        if (field === "comments") {
            const m = db.select().from(schema.messages)
                .where(and(eq(schema.messages.ticketId, id), eq(schema.messages.kind, "comment_added")))
                .all();
            return m.length;
        }
        throw new Error(`unknown ticket field '${field}'`);
    }
    if (parts[0] === "message") {
        const id = Number(parts[1]);
        const field = parts.slice(2).join(".");
        const m = getDb().select().from(schema.messages).where(eq(schema.messages.id, id)).get();
        if (!m) throw new Error(`message ${id} not found`);
        if (field === "decision_status") {
            const meta = m.meta ? (JSON.parse(m.meta) as { decision?: { status?: string } }) : {};
            return meta.decision?.status ?? null;
        }
        if (field === "status") return m.status;
        throw new Error(`unknown message field '${field}'`);
    }
    if (parts[0] === "unread") {
        // #985 — unseen ping rows for a consumer. The golden path asserts this
        // drops to 0 after the loop wakes (wake delivery marks the head seen).
        const consumer = parts.slice(1).join(".");
        const rows = getDb().select().from(schema.pings)
            .where(and(eq(schema.pings.recipient, consumer), isNull(schema.pings.seenAt)))
            .all();
        return rows.length;
    }
    throw new Error(`unknown query path '${path}'`);
}

async function main(): Promise<void> {
    const [cmd, arg] = process.argv.slice(2);
    let out: unknown;
    if (cmd === "seed") out = await seed(arg);
    else if (cmd === "mutate") out = await mutate(JSON.parse(arg) as Record<string, unknown>);
    else if (cmd === "query") out = query(arg);
    else throw new Error(`usage: daemon-ctl.ts seed|mutate|query <arg>`);
    process.stdout.write(JSON.stringify(out));
}

main().catch((e) => {
    process.stderr.write(`daemon-ctl error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
});
