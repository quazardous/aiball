/**
 * #464 — agent live-pane mirror.
 *
 * `GET /api/agents/:name/pane/stream` opens a Server-Sent-Events stream
 * that pushes a tmux/psmux `capture-pane` snapshot of the agent's loop
 * session every ~1s. Read-only (slice 1) — no keystroke forwarding, no
 * scroll back, just the current visible pane content as plain text.
 *
 * Why SSE : single-direction (server → client), survives long-lived
 * connections natively, and aiball's daemon already runs Express +
 * `Connection: keep-alive`. No new transport to plumb (WS stays for
 * bidirectional events).
 *
 * Cross-platform — david `7cef3d` : "faut que ça marche avec psmux aussi".
 * We shell out to `${MUX_CMD}` (claude-loop's tmux/psmux indirection from
 * `src/claude-loop/state.ts:29`), so on a psmux host the `tmux` alias on
 * PATH transparently routes here. ANSI escapes (the `-e` capture flag) are
 * NOT requested : keeps the payload homogeneous across tmux and psmux
 * (which doesn't necessarily support `-e`), and lets the UI render the
 * pane as plain `<pre>` text — no xterm.js dep (~200KB saved).
 *
 * Auth : the existing `bearerAuth` middleware gates the whole `/api/*`
 * tree before we land here. Browser callers come through with the
 * session cookie, agent callers with a bearer — both work without any
 * additional path.
 */
import { Router, type Request, type Response } from "express";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { MUX_CMD, tmuxName } from "../claude-loop/state.js";
import { captureCursor } from "../pane.js";
import { getConsumer } from "../db.js";
import {
    getNodeSocketForConsumerIp,
    listConnectedNodeIds,
    newRequestId,
    registerResponseHandler,
    unregisterResponseHandler,
} from "../proxy-ws.js";
import { listNodes } from "../db/nodes.js";

export const agentsRouter = Router();

/**
 * #464 — resolve a consumer to its live claude-loop name.
 *
 * The loop dir lives at `~/.claude-loop/<loop_name>/` (overridable via
 * `CLAUDE_LOOP_STATE_ROOT`) ; each carries a `plate.json` with the loop's
 * cwd. The consumer record stores its own `cwd` (pushed via the state
 * heartbeat, db/consumers.ts), so we match the two : a consumer's loop
 * is the dir whose plate.cwd == consumer.cwd.
 *
 * Why path-keyed instead of name-keyed : claude-loop names are
 * arbitrary (often `cl-<project>-<agent>`) and don't necessarily match
 * the consumer_id. The cwd, on the other hand, is one canonical key
 * already established by claude-loop's own lock + the consumer
 * heartbeat. Same identity dimension on both sides.
 *
 * Returns null when no live loop matches.
 */
function resolveLoopName(cwd: string): string | null {
    const stateRoot = process.env.CLAUDE_LOOP_STATE_ROOT
        ?? join(homedir(), ".claude-loop");
    if (!existsSync(stateRoot)) return null;
    let entries: string[];
    try { entries = readdirSync(stateRoot); } catch { return null; }
    for (const dir of entries) {
        const platePath = join(stateRoot, dir, "plate.json");
        if (!existsSync(platePath)) continue;
        try {
            const plate = JSON.parse(readFileSync(platePath, "utf8")) as { cwd?: string };
            if (plate.cwd === cwd) return dir;
        } catch {
            /* ignore malformed plate */
        }
    }
    return null;
}

const POLL_INTERVAL_MS = 1000;
/** Maximum length of an agent name we'll plumb into a shell command. Defensive
 *  bound — claude-loop names are short, this rejects pathological inputs
 *  early without bothering tmux. */
const MAX_NAME_LEN = 64;
/** Soft cap on a single capture payload — pane content is at most a few KB
 *  in practice but if something explodes we don't want to spam the SSE
 *  channel with megabyte frames. */
const MAX_PAYLOAD_BYTES = 64_000;

agentsRouter.get("/agents/:name/pane/stream", (req: Request, res: Response) => {
    const rawName = req.params.name;
    const consumerId = typeof rawName === "string" ? rawName : "";
    if (!consumerId || consumerId.length > MAX_NAME_LEN || !/^[A-Za-z0-9._-]+$/.test(consumerId)) {
        return res.status(400).json({ error: "bad consumer id" });
    }
    // Resolve consumer → cwd → loop name. The URL carries the consumer id
    // (what the UI knows about) ; the tmux session name is a runtime
    // construct claude-loop assigns at start. We bridge the two via cwd.
    const consumer = getConsumer(consumerId);
    if (!consumer) {
        return res.status(404).json({ error: `consumer not found : ${consumerId}` });
    }
    // #505 phase 2 — node-relayed agent : on route via la WS reverse au node
    // qui héberge le pane, au lieu de dégrader en `event:unavailable` (#503).
    // Fallback sur le message d'indispo si le node n'est PAS actuellement
    // connecté en WS (down ou pas encore restart sur la nouvelle build).
    if (consumer.last_seen_via === "node") {
        const ws = getNodeSocketForConsumerIp(consumer.last_seen_ip ?? null);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();
        if (!ws) {
            // #505 — diagnostic enrichi : on dit POURQUOI on n'a pas trouvé.
            const connectedIds = listConnectedNodeIds();
            const allNodes = listNodes();
            const matchingNode = allNodes.find((n) => n.last_seen_ip === consumer.last_seen_ip);
            let hint: string;
            if (connectedIds.length === 0) {
                hint = "No proxy node currently has a live WS to this daemon. Restart the daemon on the node hosting this agent (the WS client opens at boot).";
            } else if (!matchingNode) {
                hint = `No node row matches consumer.last_seen_ip=${consumer.last_seen_ip ?? "null"}. Connected nodes (${connectedIds.length}): ${connectedIds.join(", ")}. Likely the consumer hasn't been re-touched since the node's IP changed — wait for next agent request through the proxy.`;
            } else {
                hint = `Node ${matchingNode.node_id} (${matchingNode.label}) is registered but its WS is not open right now. Connected node IDs: ${connectedIds.join(", ") || "(none)"}. Restart the proxy daemon on that node.`;
            }
            res.write(`event: unavailable\ndata: ${JSON.stringify({
                error: hint,
                consumer_id: consumerId,
                last_seen_via: "node",
                last_seen_ip: consumer.last_seen_ip ?? null,
                connected_node_ids: connectedIds,
                matching_node_id: matchingNode?.node_id ?? null,
            })}\n\n`);
            res.end();
            return;
        }
        if (!consumer.cwd) {
            res.write(`event: unavailable\ndata: ${JSON.stringify({
                error: "consumer has no cwd — needs an active claude-loop heartbeat first",
                consumer_id: consumerId,
            })}\n\n`);
            res.end();
            return;
        }
        // Stream relayé : on ouvre côté node, on forward chaque `pane.frame`
        // comme SSE `data:`. Sur close du browser → on signale `pane.stream.close`
        // au node + unregister le handler.
        const requestId = newRequestId();
        res.write("retry: 1500\n\n");
        let stopped = false;
        registerResponseHandler(requestId, (frame) => {
            if (stopped) return;
            if (frame.kind === "pane.frame") {
                try { res.write(`data: ${JSON.stringify(frame)}\n\n`); } catch { stopped = true; }
            } else if (frame.kind === "pane.error") {
                try { res.write(`event: error\ndata: ${JSON.stringify({ error: frame.error })}\n\n`); } catch { /* */ }
            }
        });
        const closeStream = (): void => {
            if (stopped) return;
            stopped = true;
            unregisterResponseHandler(requestId);
            try { ws.send(JSON.stringify({ kind: "pane.stream.close", request_id: requestId })); } catch { /* */ }
            try { res.end(); } catch { /* */ }
        };
        req.on("close", closeStream);
        req.on("error", closeStream);
        res.on("error", closeStream);
        try {
            ws.send(JSON.stringify({ kind: "pane.stream.open", request_id: requestId, consumer_id: consumerId, cwd: consumer.cwd }));
        } catch {
            closeStream();
        }
        return;
    }
    if (!consumer.cwd) {
        return res.status(404).json({
            error: `consumer has no cwd — needs an active claude-loop heartbeat first`,
        });
    }
    const loopName = resolveLoopName(consumer.cwd);
    if (!loopName) {
        return res.status(404).json({
            error: `no claude-loop dir matches cwd ${consumer.cwd}`,
        });
    }
    const target = `${tmuxName(loopName)}.0`;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable buffering on nginx-style proxies
    res.flushHeaders?.();

    // Suggested reconnect delay if the connection drops — browsers honour this.
    res.write("retry: 1500\n\n");

    let stopped = false;
    function close() {
        if (stopped) return;
        stopped = true;
        clearInterval(iv);
        try { res.end(); } catch { /* already closed */ }
    }

    function tick() {
        if (stopped) return;
        // Async spawn so a slow capture doesn't block the event loop. capture-pane
        // is normally instant ; we still cap the lifetime + payload size.
        // `-e` preserves ANSI escape sequences (colours / bold / cursor) so the
        // browser-side xterm.js renders the pane with its actual colours.
        // Flags are passed separated (`-e -p`): psmux <= v3.3.4 silently dropped
        // clustered short-flag forms in capture-pane (returned exit 0 + empty
        // stdout); upstream fix is in psmux commit 72d08aa.
        const child = spawn(MUX_CMD, ["capture-pane", "-e", "-p", "-t", target], { stdio: ["ignore", "pipe", "pipe"] });
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        child.stdout.on("data", (b: Buffer) => {
            if (truncated) return;
            total += b.length;
            if (total > MAX_PAYLOAD_BYTES) {
                truncated = true;
                chunks.push(b.slice(0, Math.max(0, MAX_PAYLOAD_BYTES - (total - b.length))));
                try { child.kill("SIGTERM"); } catch { /* noop */ }
            } else {
                chunks.push(b);
            }
        });
        // #531 — fetch the pane's cursor in parallel with capture-pane. psmux
        // on Windows does not emit a positioning escape at the tail of the
        // capture-pane output (tmux on Linux does), so the frontend must
        // explicitly re-position the cursor after writing the snapshot or it
        // lands wherever the last char of the snapshot left it.
        const cursorPromise = captureCursor(target);
        child.on("error", (e) => {
            if (stopped) return;
            send({ error: `spawn failed : ${e.message}` }, "error");
        });
        child.on("close", async (code) => {
            if (stopped) return;
            if (code !== 0 && !truncated) {
                send({ error: `capture-pane exited ${code}`, target }, "error");
                return;
            }
            const text = Buffer.concat(chunks).toString("utf8");
            const cursor = await cursorPromise;
            send({ text, target, truncated, captured_at: new Date().toISOString(), cursor });
        });
    }

    function send(payload: unknown, event?: string) {
        if (stopped) return;
        const lines: string[] = [];
        if (event) lines.push(`event: ${event}`);
        lines.push(`data: ${JSON.stringify(payload)}`);
        try {
            res.write(lines.join("\n") + "\n\n");
        } catch {
            close();
        }
    }

    // First frame immediately, then every POLL_INTERVAL_MS.
    tick();
    const iv = setInterval(tick, POLL_INTERVAL_MS);

    req.on("close", close);
    req.on("error", close);
    res.on("error", close);
});

// ---------------------------------------------------------------------------
// #472 — read-write : forward browser keystrokes to the agent's tmux pane.
//
// Slice 1 read-only (#464) showed the pane ; this completes the loop by
// letting the operator type back. xterm.js's `onData(callback)` emits the
// raw bytes the user produced (printable chars, escape sequences for
// arrows / control keys, etc.). The frontend POSTs each batch here and we
// call `${MUX_CMD} send-keys -l -t cl-<loop>.0 -- <keys>` — `-l` (literal)
// pipes every byte through unchanged, so a `\x03` from the browser becomes
// a real Ctrl-C in the pane, an arrow-key escape sequence stays untouched,
// etc.
//
// Defensive : same agent-name regex + length cap as the SSE, plus a body
// length cap (4 KB) — typical keystroke batches are < 100 bytes, anything
// huge is either a paste (which the UI batches differently) or abuse.
//
// Auth : nothing extra. The bearer-auth chain upstream already gates
// every `/api/*` request ; if you can drive the loop from the CLI you can
// drive it from the browser (which is a fair model for moderators). A
// future `?moderator-only` narrowing can layer on top without changing
// the wire shape.
//
// Echo : visible via the existing SSE on the next ~1s capture tick. There's
// a ~1s round-trip lag between key-press and seeing it on screen — slice 1
// trades latency for protocol simplicity. A pipe-pane / fifo stream
// upgrade is a follow-up.
// ---------------------------------------------------------------------------

/** Max payload length per send-keys call. Typical xterm `onData` chunks are
 *  < 100 bytes (a single keypress or a small input); we cap at 4 KB to
 *  bound the shell command size + reject pathological pastes. The frontend
 *  can batch its own data into multiple POSTs if it ever needs more. */
const MAX_KEYS_BYTES = 4_096;

agentsRouter.post("/agents/:name/pane/keys", async (req: Request, res: Response) => {
    const rawName = req.params.name;
    const consumerId = typeof rawName === "string" ? rawName : "";
    if (!consumerId || consumerId.length > MAX_NAME_LEN || !/^[A-Za-z0-9._-]+$/.test(consumerId)) {
        return res.status(400).json({ error: "bad consumer id" });
    }
    const keys = (req.body as { keys?: unknown } | undefined)?.keys;
    if (typeof keys !== "string") {
        return res.status(400).json({ error: "keys must be a string" });
    }
    if (keys.length === 0) {
        // Nothing to send — accept silently. xterm sometimes emits empty
        // events at the boundaries of buffered input ; rejecting them would
        // be noisy and the no-op is what the user expects anyway.
        return res.status(204).end();
    }
    if (Buffer.byteLength(keys, "utf8") > MAX_KEYS_BYTES) {
        return res.status(413).json({ error: `keys payload exceeds ${MAX_KEYS_BYTES} bytes` });
    }
    const consumer = getConsumer(consumerId);
    if (!consumer) {
        return res.status(404).json({ error: `consumer not found : ${consumerId}` });
    }
    // #505 phase 2 — node-relayed agent : route via WS reverse au lieu du 501.
    // Fallback 503 si le node n'est pas connecté en WS (peut être restart en
    // cours / pas encore upgraded sur la nouvelle build).
    if (consumer.last_seen_via === "node") {
        const ws = getNodeSocketForConsumerIp(consumer.last_seen_ip ?? null);
        if (!ws) {
            // #505 — même diagnostic enrichi que /pane/stream.
            const connectedIds = listConnectedNodeIds();
            const allNodes = listNodes();
            const matchingNode = allNodes.find((n) => n.last_seen_ip === consumer.last_seen_ip);
            return res.status(503).json({
                error: connectedIds.length === 0
                    ? "No proxy node currently has a live WS to this daemon."
                    : !matchingNode
                        ? `No node row matches consumer.last_seen_ip=${consumer.last_seen_ip ?? "null"}.`
                        : `Node ${matchingNode.node_id} (${matchingNode.label}) is registered but its WS is not open right now.`,
                consumer_id: consumerId,
                last_seen_ip: consumer.last_seen_ip ?? null,
                connected_node_ids: connectedIds,
                matching_node_id: matchingNode?.node_id ?? null,
            });
        }
        if (!consumer.cwd) {
            return res.status(404).json({
                error: `consumer has no cwd — needs an active claude-loop heartbeat first`,
            });
        }
        const requestId = newRequestId();
        // POST keys = one-shot : on attend UN ack (ok/error) avec un timeout
        // raisonnable (3s) — send-keys est instant en local côté node.
        const ackPromise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
            const timer = setTimeout(() => {
                unregisterResponseHandler(requestId);
                resolve({ ok: false, error: "timeout waiting for node ack" });
            }, 3000);
            registerResponseHandler(requestId, (frame) => {
                if (frame.kind !== "pane.ack") return;
                clearTimeout(timer);
                unregisterResponseHandler(requestId);
                resolve({ ok: !!frame.ok, error: typeof frame.error === "string" ? frame.error : undefined });
            });
        });
        try {
            ws.send(JSON.stringify({ kind: "pane.keys", request_id: requestId, consumer_id: consumerId, cwd: consumer.cwd, keys }));
        } catch (e) {
            unregisterResponseHandler(requestId);
            return res.status(502).json({ error: `failed to send to node: ${(e as Error).message}` });
        }
        const ack = await ackPromise;
        if (ack.ok) return res.status(204).end();
        return res.status(502).json({ error: ack.error ?? "node refused" });
    }
    if (!consumer.cwd) {
        return res.status(404).json({
            error: `consumer has no cwd — needs an active claude-loop heartbeat first`,
        });
    }
    const loopName = resolveLoopName(consumer.cwd);
    if (!loopName) {
        return res.status(404).json({
            error: `no claude-loop dir matches cwd ${consumer.cwd}`,
        });
    }
    const target = `${tmuxName(loopName)}.0`;

    // david `xwmrhv` — claude-loop integration. `tmux send-keys` bypasses
    // the PTY proxy (it's a tmux IPC, not stdin through the proxy), so the
    // `human-typing` marker that the PTY proxy normally touches on each
    // human keystroke is never set on this code path. claude-loop's wake
    // timer keys off this marker (+ `user-took-over` for the longer grace
    // window) to know "a human is at the keyboard, don't inject wake
    // phrases". Without these touches the timer can race the browser-typed
    // input. We mirror the proxy's behaviour : write a fresh ISO timestamp
    // to both markers on every POST. Best-effort — a write failure just
    // means the badge stays cold, never blocks the send.
    const stateRoot = process.env.CLAUDE_LOOP_STATE_ROOT
        ?? join(homedir(), ".claude-loop");
    const sd = join(stateRoot, loopName);
    const nowIso = new Date().toISOString() + "\n";
    try { writeFileSync(join(sd, "human-typing"), nowIso); } catch { /* best-effort */ }
    try { writeFileSync(join(sd, "user-took-over"), nowIso); } catch { /* best-effort */ }

    // `-l` keeps every byte literal — no Enter/BSpace/etc. name parsing on
    // the tmux side, so xterm's raw escape sequences round-trip cleanly.
    // `--` separates flags from the keystroke string so a leading `-` in
    // the user's input doesn't get parsed as an option.
    const child = spawn(MUX_CMD, ["send-keys", "-l", "-t", target, "--", keys], {
        stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.on("error", (e) => {
        if (res.headersSent) return;
        res.status(500).json({ error: `spawn failed : ${e.message}` });
    });
    child.on("close", (code) => {
        if (res.headersSent) return;
        if (code === 0) {
            res.status(204).end();
        } else {
            res.status(502).json({
                error: `send-keys exited ${code}`,
                detail: stderr.trim() || null,
            });
        }
    });
});
