/**
 * #3067 — what a loop calls all the time, on the bus: reading its consumer,
 * pushing its state and its bar, the token usage of a turn, and the message
 * lists and bookends its wakes read.
 */
import { z } from "zod";
import { consumerIdOf, defineMethod, Refusal } from "../methods.js";
import { flag } from "../params.js";
import { ensureConsumer, getConsumer, setConsumerState } from "../../db/consumers.js";
import { parseAgentBar } from "../../agent-bar.js";
import { setAgentBar } from "../../agent-bar-store.js";
import { listMessages } from "../../db/messages.js";
import { getMessage } from "../../db.js";
import { getTicketBookends, ticketsClaimedBy } from "../../db/tickets.js";
import { pickFocusClaim } from "../../db/assignment-gate.js";
import { assignWindowSec } from "../../autopoll/config.js";
import { addTicketTokenUsage } from "../../db/token-usage.js";
import { ticketStateAfter } from "../../queries/tickets.js";
import { withTags } from "../../queries/decorate.js";
import { broadcast } from "../../ws.js";
import { setTmuxClients } from "../../sessions/tmux-clients.js";
import { tmuxSessionView } from "../../sessions/registry.js";
import { ERROR_CODES, type MessageKind, type MessageStatus } from "../../domain.js";

/** #397 — one consumer's record, its micro-prompt included: the loop reads its own for the wake. */
defineMethod({
    name: "consumer.get",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string() }),
    run: (_caller, p) => {
        const c = getConsumer(p.consumer_id);
        if (!c) throw new Refusal(404, "consumer not found", ERROR_CODES.CONSUMER_NOT_FOUND);
        return c;
    },
});

/**
 * #3340 — a tmux loop says who is attached to its session: how many clients,
 * how many with the controls. Kept while the loop is present; a change is
 * broadcast with the agent's session view (`consumer_changed { session }`),
 * as a host's clients are.
 */
defineMethod({
    name: "consumer.push_clients",
    who: ["agent"],
    params: z.object({ consumer_id: z.string(), clients: z.number().int().min(0), interactive: z.number().int().min(0) }),
    run: (caller, p) => {
        const me = consumerIdOf(caller);
        if (p.consumer_id !== me) throw new Refusal(403, "can only push clients for your own consumer_id");
        if (p.interactive > p.clients) throw new Refusal(400, "interactive cannot exceed clients");
        if (setTmuxClients(me, { clients: p.clients, interactive: p.interactive })) {
            broadcast({ type: "consumer_changed", data: { consumer_id: me, session: tmuxSessionView(me) } });
        }
        return { consumer_id: me, clients: p.clients, interactive: p.interactive };
    },
});

/**
 * A loop's state (`busy`, `idle`, `boot`), with the human's presence and its
 * word, the loop's root and project. Own state only, and agents only; the
 * board hears of it only when something changed (#1132).
 */
defineMethod({
    name: "consumer.push_state",
    who: ["human", "agent"],
    params: z.object({
        consumer_id: z.string(),
        state: z.unknown().optional(),
        human: z.unknown().optional(),
        human_word: z.unknown().optional(),
        cwd: z.unknown().optional(),
        project: z.unknown().optional(),
    }),
    run: (caller, p) => {
        const me = consumerIdOf(caller);
        if (p.consumer_id !== me) throw new Refusal(403, "can only push state for your own consumer_id");
        const c = getConsumer(me);
        if (!c) ensureConsumer(me);
        else if (c.kind === "human") throw new Refusal(403, "state push is for loop agents, not humans");
        if (p.state !== "busy" && p.state !== "idle" && p.state !== "boot") throw new Refusal(400, "state must be one of: busy, idle, boot");
        const human = typeof p.human === "boolean" ? p.human : undefined;
        const humanWord = p.human_word === "stop" || p.human_word === "wait" || p.human_word === "boot" || p.human_word === "loop" ? p.human_word : undefined;
        const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : undefined;
        const project = typeof p.project === "string" && p.project ? p.project : undefined;
        setConsumerState(me, p.state, human, humanWord, cwd, project);
        const changed = !c
            || c.state !== p.state
            || (human !== undefined && (c.state_human ?? null) !== human)
            || (humanWord !== undefined && (c.state_human_word ?? null) !== humanWord);
        if (changed) broadcast({ type: "consumer_changed", data: { consumer_id: me, state: p.state, human, human_word: humanWord } });
        return { consumer_id: me, state: p.state, human, human_word: humanWord, cwd, project };
    },
});

/** #3030 — a loop's bar as data, pushed on change. Own bar only, and agents only. */
defineMethod({
    name: "consumer.push_bar",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string(), bar: z.unknown() }),
    run: (caller, p) => {
        const me = consumerIdOf(caller);
        if (p.consumer_id !== me) throw new Refusal(403, "can only push the bar of your own consumer_id");
        if (getConsumer(me)?.kind === "human") throw new Refusal(403, "the bar is a loop agent's, not a human's");
        const bar = parseAgentBar(p.bar);
        if ("error" in bar) throw new Refusal(400, bar.error);
        return { consumer_id: me, changed: setAgentBar(me, bar) };
    },
});

/**
 * #404 — add a turn's token usage to a ticket: the one the caller holds by
 * claim (#439), else the one it names. The answer carries the ticket's row
 * (#2072), whose token chip changed.
 */
defineMethod({
    name: "ticket.add_token_usage",
    who: ["human", "agent"],
    params: z.object({ id: z.coerce.number(), in: z.unknown().optional(), out: z.unknown().optional(), cache_w: z.unknown().optional(), cache_r: z.unknown().optional() }),
    run: (caller, p) => {
        const me = consumerIdOf(caller);
        const focus = pickFocusClaim(
            ticketsClaimedBy(me).map((c) => ({ id: c.id, claimedAt: c.claimed_at })),
            Date.now(),
            assignWindowSec() * 1000,
        );
        const id = focus ?? p.id;
        const t = getMessage(id);
        if (!t || t.kind !== "ticket_created") throw new Refusal(404, "ticket not found", ERROR_CODES.TICKET_NOT_FOUND);
        const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
        addTicketTokenUsage(id, { in: n(p.in), out: n(p.out), cacheW: n(p.cache_w), cacheR: n(p.cache_r) });
        return { ticket_id: id, marker_id: p.id, ok: true, ticket: ticketStateAfter(id, me) };
    },
});

/**
 * Messages, filtered by status, project, kind and author; `open` (#2339)
 * drops closed tickets before the limit, `summary` (#2198) drops the bodies.
 */
defineMethod({
    name: "message.list",
    who: ["human", "agent"],
    params: z.object({
        status: z.string().optional(),
        project: z.string().optional(),
        kind: z.string().optional(),
        by_agent: z.string().optional(),
        limit: z.coerce.number().optional(),
        summary: flag,
        open: flag,
    }),
    run: (_caller, p) => {
        const list = listMessages({
            status: p.status as MessageStatus | undefined,
            project: p.project,
            kind: p.kind as MessageKind | undefined,
            by_agent: p.by_agent,
            limit: p.limit || undefined,
            open: p.open === true,
        });
        const rows = p.summary === true
            ? list.map((m) => {
                const r: Record<string, unknown> = { ...m };
                delete r.body;
                delete r.original_body;
                return r;
            }) as unknown as typeof list
            : list;
        return withTags(rows);
    },
});

/** The first and last open tickets of a project, snoozed ones left out unless `include_snoozed`. */
defineMethod({
    name: "ticket.bookends",
    who: ["human", "agent"],
    params: z.object({ project: z.string().optional(), include_snoozed: flag }),
    run: (_caller, p) => getTicketBookends({ project: p.project, includeSnoozed: p.include_snoozed === true }),
});
