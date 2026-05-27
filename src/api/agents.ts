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
import { getConsumer } from "../db.js";

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
    // #503 — node-relayed agent : the pane lives on a remote host, this daemon
    // can't `tmux capture-pane` it. Surface as an `event: unavailable` SSE frame
    // (open + 1 event + close) so the TerminalView shows the actual reason
    // instead of falling back to the generic "no response from server" timeout
    // (an HTTP 501 before SSE upgrade would be invisible to EventSource).
    // Check BEFORE the cwd-missing 404 — the "no cwd" hint is misleading for a
    // node-relayed agent (cwd may be missing OR set to the remote host's path,
    // either way it can't be reached locally).
    if (consumer.last_seen_via === "node") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.flushHeaders?.();
        const payload = {
            error: "Web terminal not available for node-relayed agents — the pane lives on a different host.",
            consumer_id: consumerId,
            last_seen_via: "node",
            last_seen_ip: consumer.last_seen_ip ?? null,
        };
        res.write(`event: unavailable\ndata: ${JSON.stringify(payload)}\n\n`);
        res.end();
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
        // browser-side xterm.js renders the pane with its actual colours (david
        // `anz94c` : "du moment que le runtime js est en cache osef du poids" →
        // OK to ship xterm.js for proper rendering). Caveat psmux : its
        // `capture-pane` may handle `-e` differently — to validate with #467.
        const child = spawn(MUX_CMD, ["capture-pane", "-ep", "-t", target], { stdio: ["ignore", "pipe", "pipe"] });
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
        child.on("error", (e) => {
            if (stopped) return;
            send({ error: `spawn failed : ${e.message}` }, "error");
        });
        child.on("close", (code) => {
            if (stopped) return;
            if (code !== 0 && !truncated) {
                send({ error: `capture-pane exited ${code}`, target }, "error");
                return;
            }
            const text = Buffer.concat(chunks).toString("utf8");
            send({ text, target, truncated, captured_at: new Date().toISOString() });
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

agentsRouter.post("/agents/:name/pane/keys", (req: Request, res: Response) => {
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
    // #503 — symmetric guard with pane/stream : a node-relayed agent's pane
    // can't be reached locally, so don't pretend to send keys to it. Check
    // BEFORE the cwd-missing 404 (same reasoning as the SSE side).
    if (consumer.last_seen_via === "node") {
        return res.status(501).json({
            error: "Web terminal write not available for node-relayed agents — the pane lives on a different host.",
            consumer_id: consumerId,
            last_seen_via: "node",
        });
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
