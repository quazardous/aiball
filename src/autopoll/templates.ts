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
}

export function formatReason(tone: AutopollTone, payload: AutopollPayload): string {
    const ticketList = payload.recent_tickets
        .map((t) => {
            const title = (t.title ?? "(no title)").slice(0, 80);
            return `  - #B.${t.id} (${t.project}) ${title}`;
        })
        .join("\n");

    switch (tone) {
        case "hint":
            return ticketList
                ? `You have ${payload.pings} unread aiball ping${payload.pings === 1 ? "" : "s"}:\n${ticketList}\n\nConsider calling \`unread({pings: true, mark_read: true})\` to drain them.`
                : `You have ${payload.pings} unread aiball ping${payload.pings === 1 ? "" : "s"}. Consider calling \`unread({pings: true, mark_read: true})\`.`;

        case "directive":
            return ticketList
                ? `You have ${payload.pings} unread aiball ping${payload.pings === 1 ? "" : "s"}:\n${ticketList}\n\nDrain them via \`unread({pings: true, mark_read: true})\`, then react (reply / close / open follow-up). Do not stop to ask the human first.`
                : `You have ${payload.pings} unread aiball ping${payload.pings === 1 ? "" : "s"}. Drain them via \`unread({pings: true, mark_read: true})\`, then react.`;

        case "imperative":
            return ticketList
                ? `**YOU MUST** drain ${payload.pings} unread aiball ping${payload.pings === 1 ? "" : "s"} BEFORE doing anything else:\n${ticketList}\n\nCall \`unread({pings: true, mark_read: true})\` NOW. Then react (reply / close / open follow-up). DO NOT ask the human — the human is the moderator, not the operator.`
                : `**YOU MUST** call \`unread({pings: true, mark_read: true})\` NOW. ${payload.pings} ping${payload.pings === 1 ? "" : "s"} pending. DO NOT ask permission.`;
    }
}
