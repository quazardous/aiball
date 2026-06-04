/**
 * `claude-loop backlog [--events]` (#801) — show the backlog of the
 * loop registered for the current cwd (project + agent resolved from
 * .aiball.yaml / plate). Default = ticket backlog from `?backlog=1`
 * (hot → actionable → waiting tiers). `--events` = FIFO unread events
 * from `/api/unread` (= what the wake / MCP `unread()` would drain).
 */
import { AiballClient } from "../../client.js";
import { resolveProjectContext } from "../project-context.js";

interface BacklogOpts {
    events?: boolean;
    limit?: string;
    json?: boolean;
}

interface TicketRow {
    id?: number;
    title?: string;
    edited_title?: string;
    priority?: string;
    backlog_tier?: 0 | 1 | 2 | null;
    actionable?: boolean;
    unread?: boolean;
    hot?: boolean;
    last_actor?: string | null;
}

interface UnreadMessage {
    id?: number;
    kind?: string;
    ticket_id?: number | null;
    title?: string | null;
    by_agent?: string | null;
    hashid?: string | null;
    body?: string | null;
}

export async function cmdBacklog(opts: BacklogOpts): Promise<void> {
    const ctx = resolveProjectContext();
    const limit = Math.max(1, Math.min(500, Number(opts.limit ?? 50)));
    const client = new AiballClient({ agentId: ctx.agent });

    if (opts.events) {
        const r = await client.unread(ctx.project, limit) as { messages?: UnreadMessage[]; count?: number };
        if (opts.json) {
            process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
            return;
        }
        const messages = r.messages ?? [];
        process.stdout.write(`# unread events on ${ctx.project} (consumer: ${ctx.agent}, ${messages.length}/${r.count ?? "?"})\n`);
        if (messages.length === 0) {
            process.stdout.write(`(FIFO empty)\n`);
            return;
        }
        for (const m of messages) {
            const kind = m.kind === "ticket_created" ? "new" : m.kind === "comment_added" ? "cmt" : (m.kind ?? "?").slice(0, 3);
            const tid = m.ticket_id ?? m.id;
            const title = (m.title ?? "").slice(0, 60);
            const excerpt = m.body ? ` — ${m.body.split("\n")[0].slice(0, 50)}` : "";
            const by = m.by_agent ? ` by ${m.by_agent}` : "";
            const hashid = m.hashid ? ` #${m.hashid}` : "";
            process.stdout.write(`${kind.padEnd(3)} #${String(tid).padEnd(4)}${hashid.padEnd(8)} ${title}${by}${excerpt}\n`);
        }
        return;
    }

    const rows = await client.listTickets({
        project: ctx.project,
        backlog: "1",
        limit: String(limit),
    }) as TicketRow[] | { tickets?: TicketRow[] };
    const tickets: TicketRow[] = Array.isArray(rows) ? rows : (rows.tickets ?? []);
    if (opts.json) {
        process.stdout.write(`${JSON.stringify(tickets, null, 2)}\n`);
        return;
    }
    process.stdout.write(`# backlog on ${ctx.project} (consumer: ${ctx.agent}, ${tickets.length})\n`);
    if (tickets.length === 0) {
        process.stdout.write(`(backlog empty — nothing in your court)\n`);
        return;
    }
    for (const t of tickets) {
        const tier = t.backlog_tier === 0
            ? "[HOT]"
            : t.backlog_tier === 1
                ? "[act]"
                : t.backlog_tier === 2
                    ? "[wait]"
                    : "[ ? ]";
        const unread = t.unread ? "*" : " ";
        const prio = t.priority && t.priority !== "normal" ? `(${t.priority}) ` : "";
        const title = t.edited_title ?? t.title ?? "";
        const last = t.last_actor ? ` ← ${t.last_actor}` : "";
        process.stdout.write(`${tier} ${unread} #${String(t.id).padEnd(4)} ${prio}${title}${last}\n`);
    }
}
