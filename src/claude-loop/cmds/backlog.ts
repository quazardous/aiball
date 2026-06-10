/**
 * `claude-loop backlog [--events]` (#801) — show the backlog of the
 * loop registered for the current cwd (project + agent resolved from
 * .aiball.yaml / plate). Default = ticket backlog from `?backlog=1`
 * grouped by tier (hot / actionable / waiting). `--events` = FIFO
 * unread events from `/api/unread` (cross-project, #800), grouped by
 * hot ticket vs the rest.
 */
import { AiballClient } from "../../client.js";
import { resolveProjectContext } from "../project-context.js";
import { CL_ENV } from "../env-vars.js";

interface BacklogOpts {
    events?: boolean;
    limit?: string;
    json?: boolean;
    /** #886 follow-up : print just the bar counters `o:N b:N e:N` and exit. */
    counterOnly?: boolean;
    /** David <chat> : inclure les tickets en cooldown backlog wake
     *  (marker ⏳ via fmtTicket). Default = exclu (= comportement
     *  historique du route filter). */
    cooled?: boolean;
}

interface TicketRow {
    id?: number;
    title?: string;
    edited_title?: string;
    priority?: string;
    backlog_tier?: 0 | 1 | 2 | 3 | 4 | null;
    actionable?: boolean;
    unread?: boolean;
    hot?: boolean;
    last_actor?: string | null;
    backlog_cooled_until?: string | null;
}

interface UnreadMessage {
    id?: number;
    kind?: string;
    project?: string | null;
    ticket_id?: number | null;
    title?: string | null;
    by_agent?: string | null;
    hashid?: string | null;
    body?: string | null;
}

/**
 * #805 david : les 3-char kinds sont ambigus (res = accepted ou rejected ?
 * tic = closed ou reopened ?). Mapping explicite + indicateur +/- pour
 * les décisions accepted/rejected.
 */
const KIND_LABEL: Record<string, string> = {
    ticket_created: "new",
    comment_added: "comment",
    ticket_closed: "closed",
    ticket_reopened: "reopened",
    ticket_resolved: "resolved",
    ticket_referenced: "ref",
    ticket_sub_added: "sub",
    ticket_relation: "rel",
    plan_accepted: "+plan",
    plan_rejected: "-plan",
    resolution_accepted: "+resolution",
    resolution_rejected: "-resolution",
    wontfix_accepted: "+wontfix",
    wontfix_rejected: "-wontfix",
    escalation_accepted: "+escalation",
    escalation_rejected: "-escalation",
};

function fmtEvent(m: UnreadMessage, currentProject: string): string {
    const rawKind = m.kind ?? "?";
    const kind = KIND_LABEL[rawKind] ?? rawKind;
    const tid = m.ticket_id ?? m.id;
    const title = (m.title ?? "").slice(0, 60);
    const excerpt = m.body ? ` — ${m.body.split("\n")[0].slice(0, 50)}` : "";
    const by = m.by_agent ? ` by ${m.by_agent}` : "";
    const hashid = m.hashid ? ` #${m.hashid}` : "";
    const projPrefix = m.project && m.project !== currentProject ? `[${m.project}] ` : "";
    return `${kind.padEnd(11)} ${projPrefix}#${String(tid).padEnd(4)}${hashid.padEnd(8)} ${title}${by}${excerpt}`;
}

function fmtTicket(t: TicketRow): string {
    // `*` = unread (au moins 1 ping pas vu)
    // `⏳` = en cooldown (backlog wake fired, pause jusqu'à backlog_cooled_until)
    const marker = t.backlog_cooled_until
        ? "⏳"
        : t.unread ? "*" : " ";
    const prio = t.priority && t.priority !== "normal" ? `(${t.priority}) ` : "";
    const title = t.edited_title ?? t.title ?? "";
    const last = t.last_actor ? ` ← ${t.last_actor}` : "";
    return `${marker} #${String(t.id).padEnd(4)} ${prio}${title}${last}`;
}

export async function cmdBacklog(opts: BacklogOpts): Promise<void> {
    const ctx = resolveProjectContext();
    const limit = Math.max(1, Math.min(500, Number(opts.limit ?? 50)));
    const client = new AiballClient({ agentId: ctx.agent });

    if (opts.counterOnly) {
        // Aligné avec le bar (cf. timer.ts:1070) :
        //   - open    : project-scoped si loop attaché à un projet
        //   - backlog : project-scoped (idem ?backlog=1&project=…)
        //   - events  : cross-project (pingsCount.unread)
        // #911 david : passe `cooldown_sec` (= idem list mode plus bas)
        // + filter cooled post-fetch pour que `b:N` match exactly ce
        // que `claude-loop backlog` (sans --cooled) affiche. Sans ça,
        // counter compte ALL = cooled inclus, list = uniquement
        // non-cooled → désynchro user-visible.
        const cooldownSec = process.env[CL_ENV.BACKLOG_COOLDOWN_SEC] ?? "3600";
        const [projects, backlogRows, unread] = await Promise.all([
            client.listProjectsDetailed(),
            client.listTickets({
                backlog: "1",
                limit: "500",
                project: ctx.project,
                cooldown_sec: cooldownSec,
            }) as Promise<TicketRow[] | { tickets?: TicketRow[] }>,
            client.unread(null, 1) as Promise<{ count?: number }>,
        ]);
        const open = projects.find((p) => p.name === ctx.project)?.open_count ?? 0;
        const allBacklogTickets: TicketRow[] = Array.isArray(backlogRows)
            ? backlogRows
            : (backlogRows.tickets ?? []);
        // Mirror `claude-loop backlog` (default sans --cooled) : exclude
        // les tickets en cooldown via `backlog_cooled_until` set.
        const backlogTickets = allBacklogTickets.filter((t) => !t.backlog_cooled_until);
        const backlog = backlogTickets.length;
        const events = unread.count ?? 0;
        if (opts.json) {
            process.stdout.write(`${JSON.stringify({ open, backlog, events })}\n`);
        } else {
            process.stdout.write(`o:${open} b:${backlog} e:${events}\n`);
        }
        return;
    }

    if (opts.events) {
        // FIFO consumer-scoped (cross-project, #800).
        const r = await client.unread(null, limit) as { messages?: UnreadMessage[]; count?: number };
        if (opts.json) {
            process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
            return;
        }
        const messages = r.messages ?? [];
        // #801 bz66g6 : group hot events first, then the rest. "Hot" =
        // event's parent ticket is in the consumer's HOT tier today.
        // Fetch the hot ticket-ids set from the backlog API (one round
        // trip ; cheap vs per-message lookup).
        const hotRows = await client.listTickets({
            backlog: "1",
            limit: "500",
        }) as TicketRow[] | { tickets?: TicketRow[] };
        const hotTickets: TicketRow[] = Array.isArray(hotRows) ? hotRows : (hotRows.tickets ?? []);
        const hotIds = new Set(hotTickets.filter((t) => t.backlog_tier === 0).map((t) => t.id));
        const hot = messages.filter((m) => {
            const tid = m.ticket_id ?? m.id;
            return tid !== undefined && hotIds.has(tid);
        });
        const rest = messages.filter((m) => {
            const tid = m.ticket_id ?? m.id;
            return tid === undefined || !hotIds.has(tid);
        });

        process.stdout.write(`# unread events (consumer: ${ctx.agent}, cross-project, ${messages.length}/${r.count ?? "?"})\n`);
        if (messages.length === 0) {
            process.stdout.write(`(FIFO empty)\n`);
            return;
        }
        if (hot.length > 0) {
            process.stdout.write(`\n## HOT (${hot.length})\n`);
            for (const m of hot) process.stdout.write(`${fmtEvent(m, ctx.project)}\n`);
        }
        if (rest.length > 0) {
            process.stdout.write(`\n## rest (${rest.length})\n`);
            for (const m of rest) process.stdout.write(`${fmtEvent(m, ctx.project)}\n`);
        }
        return;
    }

    // #790 david `vc4pxz` : sans `cooldown_sec`, l'API laisse
    // `backlog_cooled_until` à null → impossible de distinguer un ticket
    // en cooldown. CLI passe le default 3600s (match CL_BACKLOG_COOLDOWN_SEC
    // côté state.ts) pour que --cooled puisse afficher l'horizon.
    const rows = await client.listTickets({
        project: ctx.project,
        backlog: "1",
        limit: String(limit),
        cooldown_sec: String(process.env[CL_ENV.BACKLOG_COOLDOWN_SEC] ?? "3600"),
    }) as TicketRow[] | { tickets?: TicketRow[] };
    const allTickets: TicketRow[] = Array.isArray(rows) ? rows : (rows.tickets ?? []);
    // Default : exclude cooled tickets (= ancien comportement quand l'API
    // les filtrait silencieusement). `--cooled` flag les inclut avec ⏳.
    const tickets = opts.cooled
        ? allTickets
        : allTickets.filter((t) => !t.backlog_cooled_until);
    if (opts.json) {
        process.stdout.write(`${JSON.stringify(tickets, null, 2)}\n`);
        return;
    }
    // #885 — group by tier : hot (0), actionable (1), follow-up (2),
    // waiting (3). Follow-up = last_actor ≠ me + ma décision pending
    // gate l'actionable.
    // David <chat> : tickets en cooldown (`backlog_cooled_until` set) ont
    // un marker ⏳ via fmtTicket. Ils restent dans leur tier d'origine
    // (= tu vois qu'ils existent mais qu'ils sont en pause backlog wake).
    const hot = tickets.filter((t) => t.backlog_tier === 0);
    const actionable = tickets.filter((t) => t.backlog_tier === 1);
    const followUp = tickets.filter((t) => t.backlog_tier === 2);
    const waiting = tickets.filter((t) => t.backlog_tier === 3);
    const blocked = tickets.filter((t) => t.backlog_tier === 4);

    process.stdout.write(`# backlog on ${ctx.project} (consumer: ${ctx.agent}, ${tickets.length})\n`);
    if (tickets.length === 0) {
        process.stdout.write(`(backlog empty — nothing in your court)\n`);
        return;
    }
    if (hot.length > 0) {
        process.stdout.write(`\n## HOT (${hot.length})\n`);
        for (const t of hot) process.stdout.write(`${fmtTicket(t)}\n`);
    }
    if (actionable.length > 0) {
        process.stdout.write(`\n## actionable — ball in my court (${actionable.length})\n`);
        for (const t of actionable) process.stdout.write(`${fmtTicket(t)}\n`);
    }
    if (followUp.length > 0) {
        process.stdout.write(`\n## follow-up — they spoke, my decision pending blocks actionable (${followUp.length})\n`);
        for (const t of followUp) process.stdout.write(`${fmtTicket(t)}\n`);
    }
    if (waiting.length > 0) {
        process.stdout.write(`\n## waiting on them (${waiting.length})\n`);
        for (const t of waiting) process.stdout.write(`${fmtTicket(t)}\n`);
    }
    if (blocked.length > 0) {
        process.stdout.write(`\n## blocked — chain depends_on an open ticket (${blocked.length})\n`);
        for (const t of blocked) process.stdout.write(`${fmtTicket(t)}\n`);
    }
}
