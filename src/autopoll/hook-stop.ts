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
    /** Open tickets count at last notify. Bumping above this is a
     *  trigger when autopoll.backlog is true. Decreases are silent —
     *  we only re-notify on growth or on throttle elapsing. */
    last_open_count: number;
}

function stateFile(agent: string): string {
    return join(homedir(), ".cache", "aiball", `autopoll-${agent}.json`);
}

function readState(agent: string): AutopollState {
    const p = stateFile(agent);
    const empty: AutopollState = { last_notified_at: 0, last_max_ping_id: 0, last_open_count: 0 };
    if (!existsSync(p)) return empty;
    try {
        const s = JSON.parse(readFileSync(p, "utf8")) as Partial<AutopollState>;
        return {
            last_notified_at: typeof s.last_notified_at === "number" ? s.last_notified_at : 0,
            last_max_ping_id: typeof s.last_max_ping_id === "number" ? s.last_max_ping_id : 0,
            last_open_count: typeof s.last_open_count === "number" ? s.last_open_count : 0,
        };
    } catch {
        return empty;
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

    // Pings count — cheap probe.
    let count = 0;
    try {
        const r = (await client.pingsCount()) as { unread: number };
        count = typeof r?.unread === "number" ? r.unread : 0;
    } catch {
        emit({}); // daemon unreachable — never block
    }

    // Open-tickets count — fetched whether backlog is on (used in the
    // reason) or off (we still surface the number in the message).
    // We use `actionable_count` (= open minus agent-resolved) so the
    // agent isn't nagged about tickets already in the human's court
    // (#B.119). Falls back to `open_count` for old daemons.
    let openCount = 0;
    let openProject: string | null = null;
    try {
        const projects = (await client.listProjectsDetailed()) as Array<{
            name: string;
            open_count?: number;
            actionable_count?: number;
        }>;
        const filtered = cfg.consumer.project
            ? projects.filter((p) => p.name === cfg.consumer.project)
            : projects;
        openCount = filtered.reduce(
            (acc, p) => acc + (p.actionable_count ?? p.open_count ?? 0),
            0,
        );
        openProject = cfg.consumer.project;
    } catch {
        /* context-only */
    }

    // Is there anything worth surfacing right now?
    //   - any unread ping → always actionable
    //   - autopoll.backlog && open_count > 0 → backlog is a trigger
    const hasPings = count > 0;
    const hasBacklog = cfg.autopoll.backlog && openCount > 0;
    if (!hasPings && !hasBacklog) {
        // Nothing to surface. Reset watermarks so a future arrival
        // notifies immediately even if throttle is high.
        if (state.last_max_ping_id !== 0 || state.last_open_count !== 0) {
            writeState(agent, {
                last_notified_at: state.last_notified_at,
                last_max_ping_id: 0,
                last_open_count: 0,
            });
        }
        emit({});
    }

    // If we have pings, fetch the recent slice for the reason + derive
    // max_id. Skip the call when there are no pings (saves a round-trip
    // in backlog-only triggers).
    let recent: AutopollPayload["recent_tickets"] = [];
    let maxId = 0;
    if (hasPings) {
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
                    id: p.message.ticket_id ?? p.message.id,
                    title: p.message.title,
                    project: p.message.project,
                }));
            }
        } catch {
            emit({}); // daemon unreachable mid-way — never block
        }
    }

    // Decision matrix:
    //   - new ping (max_id moved)                          → notify
    //   - backlog enabled AND open_count grew              → notify
    //   - else volatile=true                                → skip (one-shot)
    //   - else throttle elapsed AND state still actionable → notify
    //   - else                                              → skip
    const newPing = maxId > state.last_max_ping_id;
    const newOpenTicket = cfg.autopoll.backlog && openCount > state.last_open_count;
    const throttleElapsed =
        cfg.autopoll.throttle_seconds === 0 ||
        nowSec - state.last_notified_at >= cfg.autopoll.throttle_seconds;
    let shouldNotify = false;
    if (newPing || newOpenTicket) {
        shouldNotify = true;
    } else if (!cfg.autopoll.volatile && throttleElapsed) {
        shouldNotify = true;
    }
    if (!shouldNotify) {
        // Sync state for decreased counts so future bumps register.
        if (openCount < state.last_open_count) {
            writeState(agent, {
                last_notified_at: state.last_notified_at,
                last_max_ping_id: state.last_max_ping_id,
                last_open_count: openCount,
            });
        }
        emit({});
    }

    const reason = formatReason(cfg.autopoll.tone, {
        pings: count,
        recent_tickets: recent,
        open_tickets: openCount > 0 ? { count: openCount, project: openProject } : undefined,
    });
    writeState(agent, {
        last_notified_at: nowSec,
        last_max_ping_id: maxId,
        last_open_count: openCount,
    });
    emit({ decision: "block", reason });
}

main().catch(() => {
    // Last-resort: any unexpected error → release. Never block Claude.
    process.stdout.write("{}\n");
    process.exit(0);
});
