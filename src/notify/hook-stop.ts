/**
 * Stop hook for interactive Claude Code sessions (#B.99 follow-up).
 *
 * Fires when Claude wants to stop responding. We:
 *   1. Walk up from cwd (or $CLAUDE_PROJECT_DIR if set) to find
 *      `.aiball.json`. If missing or `notify.enabled === false` → release.
 *   2. Resolve the agent id (config > env > .mcp.json). If unresolved → release.
 *   3. Check the throttle file. If we notified recently → release.
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
 * pattern (`skill/hooks/aiball-notify-stop.sh`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { AiballClient } from "../client.js";
import { loadConfig } from "./config.js";
import { formatReason, type NotifyPayload } from "./templates.js";

function emit(obj: unknown): never {
    process.stdout.write(JSON.stringify(obj) + "\n");
    process.exit(0);
}

function throttleFile(agent: string): string {
    return join(homedir(), ".cache", "aiball", `notify-${agent}.ts`);
}

function readThrottle(agent: string): number {
    const p = throttleFile(agent);
    if (!existsSync(p)) return 0;
    try {
        const n = Number.parseInt(readFileSync(p, "utf8").trim(), 10);
        return Number.isFinite(n) ? n : 0;
    } catch {
        return 0;
    }
}

function writeThrottle(agent: string, ts: number): void {
    const p = throttleFile(agent);
    try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, String(ts));
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

    if (!cfg.notify.enabled) emit({});
    if (!cfg.consumer.agent) emit({});

    // Throttle: skip if we notified < N seconds ago.
    const nowSec = Math.floor(Date.now() / 1000);
    const last = readThrottle(cfg.consumer.agent);
    if (cfg.notify.throttle_seconds > 0 && nowSec - last < cfg.notify.throttle_seconds) {
        emit({});
    }

    // Build a client bound to this consumer so the X-Aiball-Consumer
    // header is right (UDS local-trust honors it for identity).
    const client = new AiballClient({ agentId: cfg.consumer.agent });

    // Count first — sub-ms, the bail path is the common case.
    let count = 0;
    try {
        const r = (await client.pingsCount()) as { unread: number };
        count = typeof r?.unread === "number" ? r.unread : 0;
    } catch {
        emit({}); // daemon unreachable — never block
    }
    if (count === 0) emit({});

    // We have pings. Fetch the N most recent for the reason body.
    let recent: NotifyPayload["recent_tickets"] = [];
    if (cfg.notify.include_recent_tickets > 0) {
        try {
            const r = (await client.listPings({
                unreadOnly: true,
                limit: cfg.notify.include_recent_tickets,
            })) as { pings: Array<{ message: { id: number; title: string | null; project: string; ticket_id: number | null } }> };
            recent = (r.pings ?? []).map((p) => ({
                // Prefer ticket_id (the thread root) when this ping is on
                // a comment; the title comes from the message either way.
                id: p.message.ticket_id ?? p.message.id,
                title: p.message.title,
                project: p.message.project,
            }));
        } catch {
            /* keep recent empty — count alone is still useful */
        }
    }

    const reason = formatReason(cfg.notify.tone, { pings: count, recent_tickets: recent });
    writeThrottle(cfg.consumer.agent, nowSec);
    emit({ decision: "block", reason });
}

main().catch(() => {
    // Last-resort: any unexpected error → release. Never block Claude.
    process.stdout.write("{}\n");
    process.exit(0);
});
