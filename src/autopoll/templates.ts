/**
 * Tone → reason string templates for the Stop autopoll hook.
 *
 * Calibration is empirical — Claude responds differently to "consider"
 * vs "should" vs "YOU MUST" depending on the session's system prompt.
 * Project owners pick via `.aiball.json` → `autopoll.tone`.
 *
 * - `hint`       : polite, easy to override by the agent. Use when the
 *                  system prompt already nudges proactivity.
 * - `directive`  : declarative, names the action. Default.
 * - `imperative` : capitalized commands. Last resort when the agent
 *                  persists in asking-for-permission patterns.
 */
import type { AutopollTone } from "./config.js";

export interface AutopollPayload {
    pings: number;
    recent_tickets: Array<{
        id: number;
        title: string | null;
        project: string;
    }>;
    /** Optional: # of open tickets in the agent's scope. Surfaced as
     *  a "backlog" line so the agent knows there's work beyond pings. */
    open_tickets?: { count: number; project: string | null };
}

function backlogLine(tone: AutopollTone, payload: AutopollPayload): string {
    const b = payload.open_tickets;
    if (!b || b.count === 0) return "";
    const scope = b.project ? `\`${b.project}\`` : "your scope";
    const n = b.count;
    const s = n === 1 ? "" : "s";
    // Adjust the "after pings" framing depending on whether there are
    // pings to drain — when triggered by backlog alone, the line is
    // the only instruction.
    const after = payload.pings > 0 ? "After draining pings, list" : "List";
    const afterCaps = payload.pings > 0 ? "After the pings, you MUST call" : "Call";
    switch (tone) {
        case "hint":
            return `\n\nBacklog: ${n} open ticket${s} in ${scope}. Have a look via \`ticket_list({actionable: true})\` when you can.`;
        case "directive":
            return `\n\nBacklog: ${n} open ticket${s} in ${scope}. ${after} via \`ticket_list({actionable: true})\` and process them — close your own, otherwise \`ticket_reply({target_id, body, then: "resolved"})\`. If you need info before proceeding, post a plain comment with your question (the conversation IS the channel — there's no separate blocked/TBD signal anymore). A plain reply leaves the ticket in the backlog and the autopoll will nag again.`;
        case "imperative":
            return `\n\n**BACKLOG: ${n} open ticket${s} in ${scope}**. ${afterCaps} \`ticket_list({actionable: true})\` and clear EACH one with \`ticket_reply({target_id, body, then: "resolved"})\`. Need info? Post a plain comment with your question. A bare reply does NOT drain the backlog — the autopoll WILL re-fire until each ticket is resolved / closed.`;
    }
}

export function formatReason(tone: AutopollTone, payload: AutopollPayload): string {
    const ticketList = payload.recent_tickets
        .map((t) => {
            const title = (t.title ?? "(no title)").slice(0, 80);
            return `  - #${t.id} (${t.project}) ${title}`;
        })
        .join("\n");
    const backlog = backlogLine(tone, payload);

    // No pings → backlog-only trigger. Skip the "drain them" wording
    // entirely; the backlog line carries the full instruction.
    if (payload.pings === 0) {
        return backlog.replace(/^\n\n/, "");
    }

    const n = payload.pings;
    const s = n === 1 ? "" : "s";

    // #826 david `74x46c` — `mark_read` was removed from MCP. The agent
    // reads via `unread({pings: true})` (read-only) and engages each
    // ticket via `ticket_get` / `ticket_reply` ; engagement auto-acks the
    // pings on that ticket (#749 Phase A prune-on-consult). No more
    // "drain via mark_read" — the templates here mirror that flow.
    switch (tone) {
        case "hint":
            return (ticketList
                ? `You have ${n} unread aiball ping${s}:\n${ticketList}\n\nList them via \`unread({pings: true})\` ; reading each ticket via \`ticket_get\` auto-acks its pings.`
                : `You have ${n} unread aiball ping${s}. List via \`unread({pings: true})\` ; engagement auto-acks.`) + backlog;

        case "directive":
            return (ticketList
                ? `You have ${n} unread aiball ping${s}:\n${ticketList}\n\nList via \`unread({pings: true})\`, then react on each ticket (reply / close / open follow-up) — \`ticket_get\` / \`ticket_reply\` auto-ack the pings on that ticket. Do not stop to ask the human first.`
                : `You have ${n} unread aiball ping${s}. List via \`unread({pings: true})\`, react on each ticket, engagement auto-acks.`) + backlog;

        case "imperative":
            return (ticketList
                ? `**YOU MUST** handle ${n} unread aiball ping${s} BEFORE doing anything else:\n${ticketList}\n\nList via \`unread({pings: true})\` NOW, then engage each ticket (\`ticket_get\` / \`ticket_reply\`) — engagement auto-acks. DO NOT ask the human — the human is the moderator, not the operator.`
                : `**YOU MUST** call \`unread({pings: true})\` and engage NOW. ${n} ping${s} pending. DO NOT ask permission.`) + backlog;
    }
}
