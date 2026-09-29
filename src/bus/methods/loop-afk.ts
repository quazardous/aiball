/**
 * A consumer's LOCAL loop, reached through its socket: where it lives, and the
 * AFK changes the web UI and the all-loops controls send it (`consumer.afk`,
 * `loops.message_all`, `loops.release_all` on the bus). Mobile and touch
 * clients have no F9: the terminal's toolbar sends these instead.
 *
 * The daemon is another process than the loop's kernel: it does not write the
 * loop's files, it sends an event on the kernel's `loop.sock`, which applies
 * it (`afk_key` → toggle; the `set_afk_*` / `clear_afk` markers) and relays the
 * state to the proxy and the bar. Local loops only: nothing is relayed to a
 * node.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loopSockPath } from "../../claude-loop/state.js";
import { sendEventOnce } from "../../claude-loop/ipc-events.js";
import { resolveLoopName } from "../../pane.js";
import { getConsumer } from "../../db.js";
import { ERROR_CODES, type ErrorCode } from "../../domain.js";

export type LoopAfkAction = "toggle" | "off" | "arm_10m" | "arm_inf";

/**
 * The state dir of a consumer's LOCAL loop, where its socket lives, or the
 * HTTP status and reason it cannot be reached. Node-relayed loops are refused
 * (not implemented). Shared by the loop controls that go through the socket.
 */
export function localLoopDir(
    consumerId: string,
): { ok: true; loop: string; sd: string } | { ok: false; status: number; error: string; code: ErrorCode } {
    const consumer = getConsumer(consumerId);
    if (!consumer || !consumer.cwd) {
        // #3039 — an agent unknown, or without a loop heartbeat, has no loop to reach.
        return { ok: false, status: 404, error: `consumer not found / no cwd : ${consumerId}`, code: consumer ? ERROR_CODES.LOOP_NOT_FOUND : ERROR_CODES.CONSUMER_NOT_FOUND };
    }
    if (consumer.last_seen_via === "node") {
        return { ok: false, status: 501, error: "loop control over a node-relayed pane is not implemented yet", code: ERROR_CODES.NOT_IMPLEMENTED };
    }
    const loopName = resolveLoopName(consumer.cwd, consumerId);
    if (!loopName) {
        return { ok: false, status: 404, error: `no claude-loop dir matches cwd ${consumer.cwd}`, code: ERROR_CODES.LOOP_NOT_FOUND };
    }
    const stateRoot = process.env.CLAUDE_LOOP_STATE_ROOT
        ?? join(homedir(), ".claude-loop");
    const sd = join(stateRoot, loopName);
    if (!existsSync(sd)) {
        return { ok: false, status: 404, error: `loop state dir missing : ${sd}`, code: ERROR_CODES.LOOP_NOT_FOUND };
    }
    return { ok: true, loop: loopName, sd };
}

/**
 * #2333 — queue an AFK change on a consumer's LOCAL loop, through its socket.
 * Shared by the per-agent route below and the all-loops message / release
 * routes. Returns the loop name, or the HTTP status and reason it could not be
 * reached.
 */
export function sendAfkToLoop(
    consumerId: string,
    action: LoopAfkAction,
    durationSec = 600,
): { ok: true; loop: string } | { ok: false; status: number; error: string; code: ErrorCode } {
    const where = localLoopDir(consumerId);
    if (!where.ok) return where;
    const { sd, loop: loopName } = where;
    const nowMs = Date.now();
    let payload: Record<string, unknown>;
    if (action === "toggle") {
        payload = { event: "keystroke", kind: "afk_key", now_ms: nowMs };
    } else if (action === "off") {
        payload = { event: "marker", name: "clear_afk", now_ms: nowMs };
    } else if (action === "arm_10m") {
        payload = { event: "marker", name: "set_afk_10m", expiry_ms: nowMs + durationSec * 1000, now_ms: nowMs };
    } else {
        payload = { event: "marker", name: "set_afk_inf", now_ms: nowMs };
    }
    void sendEventOnce(loopSockPath(sd), { kind: "proxyEvent", data: payload }, { timeoutMs: 500 });
    return { ok: true, loop: loopName };
}


