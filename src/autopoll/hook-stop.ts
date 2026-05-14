/**
 * Stop hook for interactive Claude Code sessions — "autopoll"
 * (#B.99 follow-up). Aiball polls itself when Claude wants to stop,
 * so the agent doesn't have to remember to drain its inbox.
 *
 * Fires when Claude wants to stop responding. We:
 *   1. Walk up from cwd (or $CLAUDE_PROJECT_DIR if set) to find
 *      `.aiball.json`. If missing or `autopoll.enabled === false` → release.
 *   2. Resolve the agent id (config > env > .mcp.json). If unresolved → release.
 *   3. Check the throttle file. If we polled recently → release.
 *   4. Query the daemon for unread ping count for this agent + the N
 *      most recent ticket titles.
 *   5. If pings > 0: emit `{decision: "block", reason: "..."}` with the
 *      tone-aware reason. The agent gets the reason as a synthetic
 *      turn and is expected to drain via `unread({pings: true, mark_read: true})`.
 *   6. Bump the throttle file.
 *
 * Any error / unreachable daemon → emit `{}` and exit 0. We NEVER
 * block Claude due to a hook bug.
 *
 * Layout mirrors `src/sandbox/hook-stop.ts` — same TS-with-thin-bash
 * pattern (`skill/hooks/aiball-autopoll-stop.sh`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { AiballClient } from "../client.js";
import { loadConfig } from "./config.js";
import { formatReason, type AutopollPayload } from "./templates.js";

function emit(obj: unknown): never {
    process.stdout.write(JSON.stringify(obj) + "\n");
    process.exit(0);
}

interface AutopollState {
    /** Unix seconds when we last fired a notify for this agent. */
    last_notified_at: number;
    /** Highest ping id we've already notified about. Used to dedupe
     *  "same inbox state" repeat fires, and to bypass the throttle
     *  when a strictly newer ping shows up. */
    last_max_ping_id: number;
}

function stateFile(agent: string): string {
    return join(homedir(), ".cache", "aiball", `autopoll-${agent}.json`);
}

function readState(agent: string): AutopollState {
    const p = stateFile(agent);
    if (!existsSync(p)) return { last_notified_at: 0, last_max_ping_id: 0 };
    try {
        const s = JSON.parse(readFileSync(p, "utf8")) as Partial<AutopollState>;
        return {
            last_notified_at: typeof s.last_notified_at === "number" ? s.last_notified_at : 0,
            last_max_ping_id: typeof s.last_max_ping_id === "number" ? s.last_max_ping_id : 0,
        };
    } catch {
        return { last_notified_at: 0, last_max_ping_id: 0 };
    }
}

function writeState(agent: string, state: AutopollState): void {
    const p = stateFile(agent);
    try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(state));
    } catch {
        /* best effort */
    }
}

async function main(): Promise<void> {
    // Drain stdin (the Claude Code hook payload). We don't use it
    // today but Claude Code expects us to consume it.
    process.stdin.resume();
    process.stdin.on("data", () => {});
    process.stdin.on("error", () => {});

    const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const cfg = loadConfig(cwd);

    if (!cfg.autopoll.enabled) emit({});
    if (!cfg.consumer.agent) emit({});

    const agent = cfg.consumer.agent;
    const nowSec = Math.floor(Date.now() / 1000);
    const state = readState(agent);

    // Build a client bound to this consumer so the X-Aiball-Consumer
    // header is right (UDS local-trust honors it for identity).
    const client = new AiballClient({ agentId: agent });

    // Count first — sub-ms, the bail path is the common case.
    let count = 0;
    try {
        const r = (await client.pingsCount()) as { unread: number };
        count = typeof r?.unread === "number" ? r.unread : 0;
    } catch {
        emit({}); // daemon unreachable — never block
    }
    if (count === 0) {
        // Inbox drained — reset the watermark so future pings notify
        // immediately even if the throttle was set high.
        if (state.last_max_ping_id !== 0) {
            writeState(agent, { last_notified_at: state.last_notified_at, last_max_ping_id: 0 });
        }
        emit({});
    }

    // Fetch recent pings to (a) derive the current max_id and (b) fill
    // the notify reason. Always call this — we need max_id even when
    // include_recent_tickets is 0.
    let recent: AutopollPayload["recent_tickets"] = [];
    let maxId = 0;
    try {
        const limit = Math.max(1, cfg.autopoll.include_recent_tickets);
        const r = (await client.listPings({ unreadOnly: true, limit })) as {
            pings: Array<{
                message_id: number;
                message: { id: number; title: string | null; project: string; ticket_id: number | null };
            }>;
        };
        const pings = r.pings ?? [];
        for (const p of pings) {
            if (typeof p.message_id === "number" && p.message_id > maxId) maxId = p.message_id;
        }
        if (cfg.autopoll.include_recent_tickets > 0) {
            recent = pings.map((p) => ({
                // Prefer ticket_id (the thread root) when this ping is on
                // a comment; the title comes from the message either way.
                id: p.message.ticket_id ?? p.message.id,
                title: p.message.title,
                project: p.message.project,
            }));
        }
    } catch {
        emit({}); // daemon unreachable mid-way — never block
    }

    // Decision matrix:
    //   - new ping (max_id > last)        → notify (always bypasses throttle)
    //   - same head + volatile=true       → skip (one-shot semantics)
    //   - same head + throttle elapsed    → notify (persistent reminder)
    //   - same head + within throttle     → skip
    const newPing = maxId > state.last_max_ping_id;
    const throttleElapsed =
        cfg.autopoll.throttle_seconds === 0 ||
        nowSec - state.last_notified_at >= cfg.autopoll.throttle_seconds;
    let shouldNotify = false;
    if (newPing) {
        shouldNotify = true;
    } else if (!cfg.autopoll.volatile && throttleElapsed) {
        shouldNotify = true;
    }
    if (!shouldNotify) emit({});

    const reason = formatReason(cfg.autopoll.tone, { pings: count, recent_tickets: recent });
    writeState(agent, { last_notified_at: nowSec, last_max_ping_id: maxId });
    emit({ decision: "block", reason });
}

main().catch(() => {
    // Last-resort: any unexpected error → release. Never block Claude.
    process.stdout.write("{}\n");
    process.exit(0);
});
