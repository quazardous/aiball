# aiball — soft autoloop for Claude Code: the Never-Ending Story

![aiball pseudo-loop](./assets/aiball-loop.png)

A local daemon that holds a shared backlog for [Claude Code](https://docs.claude.com/en/docs/claude-code) and you. Pair it with `claude-loop` and your Claude session stays alive between turns: you queue tickets any time, claude wakes on each one and drains the backlog autonomously — no babysitting, no interruption mid-thinking, no lost context.

> **Today, Claude Code is the only supported agent.** The protocol is generic (MCP + a small HTTP/CLI surface) so other CLI agents could plug in, but nothing else is wired or tested yet. If you're not running Claude Code, this is interesting reading at best.

Runs on `127.0.0.1` (UDS socket, SQLite). Storage stays on your machine in `~/.local/share/aiball` (no cloud backend), no telemetry.

---

## The soft-loop

1. **You (or another Claude session) queue a ticket** at any time — via the web UI, the MCP `ticket_new` tool, or the `aiball` CLI. The ticket lands in the right project's backlog addressed to a specific Claude session (by `consumer_id`) or broadcast to project owners.
2. **A claude session is working on something** — its current turn proceeds uninterrupted. Aiball doesn't push during a turn.
3. **End-of-turn `Stop` hook fires** (registered globally or per-loop via `claude-loop`). The hook checks the consumer's backlog. If non-empty, it surfaces pending tickets + pings into the next user-facing prompt — claude sees them as if you'd just typed "here's the backlog".
4. **Claude drains the backlog**: reads tickets, posts replies (`ticket_reply`), proposes resolutions (`then: "resolved"`), closes its own (`then: "close"`). Each action emits events back to other subscribers.
5. **Loop continues** until no actionable tickets remain. Session ends cleanly with full context preserved.

The interaction model shifts from "interrupt with the next instruction" to "queue the next instruction so it lands when the agent is ready."

**Two key design choices**:
- **Decisions live on the comments** — when an agent proposes a resolution, the tag rides on the comment itself instead of a separate "decision" row. The reporter accepts or rejects in place, and the audit trail stays inside the thread where it was made.
- **SSE event-bus** — `claude-loop` sessions subscribe to `/api/events` and wake instantly on new pings, no polling lag.

**Useful primitives for Claude Code users**:
- `claude-loop start` — wrap a tmux + claude session that auto-drains aiball pings
- `claude-loop check` — diagnose subscriptions / unread state without spawning claude
- `claude-loop trace --events` — live tail of SSE events (debug)
- MCP tools — `poll` (snapshot), `unread`, `ticket_get`, `ticket_reply`, `ticket_new`, `subscribe`

**Why not slack-bot / email / issue-tracker?** Zero latency (local), per-consumer privacy (no shared inbox), event-driven (no polling), and the agent never sees an interruption mid-context.

---

## Quickstart — `claude-loop` (recommended)

The productivity unlock. A tmux wrapper that keeps claude alive between tickets: queue twenty things over the day, walk away, claude wakes on each ping (SSE event-bus, no polling lag) and drains them. No hook config to babysit, no session to re-launch — the token quota becomes the only ceiling.

### 1. Install (one-time)

```bash
git clone https://github.com/quazardous/aiball.git && cd aiball
./install.sh --auth-init      # daemon (systemd user unit) + bins (aiball, aiball-mcp, claude-loop) + invite link
```

Then open <http://127.0.0.1:7777> in your browser and follow the invite to create your human moderator account.

### 2. Wire your project (per repo)

```bash
cd <your-project>
aiball init               # writes .mcp.json + .aiball.yaml (idempotent, preserves existing MCP servers)
```

Identity defaults to `<project>-claude` (matches `basename(cwd)`). Add a `consumer:` block to `.aiball.yaml` if you want explicit overrides — see [`.aiball.yaml.example`](./.aiball.yaml.example).

### 3. Launch claude in the loop

```bash
claude-loop -- --resume       # anything after -- is forwarded to claude
```

tmux opens with claude inside. Status bar shows `[boot]` → `[idle 0]` → `[busy]` based on real claude state (pane-probed). When a ticket lands via the web UI or another claude session, claude wakes within ms and processes it. Detach with `Ctrl-B D`, re-attach with `claude-loop attach <name>`.

### Other setups

- **Interactive claude without tmux** (autopoll Stop hook between turns): see [`MCP-CLIENT.md`](./MCP-CLIENT.md) §4 — the `./install.sh --stop-hook` + `aiball autopoll init` flow for sessions you launch yourself.
- **Bare MCP** (no loop, useful for scripts / non-claude experiments — protocol works but only Claude Code is wired today): [`MCP-CLIENT.md`](./MCP-CLIENT.md).
- **Mint consumer tokens** (only needed if you want stable per-consumer auth across reboots): `aiball auth issue --consumer <name>`.
- **Remote access via Tailscale** (The Loop in your pocket): `aiball-tailscale up` exposes the local daemon to your tailnet via `tailscale serve` (storage still local on your machine; private, end-to-end encrypted, no public exposure). Full guide: [`docs/TAILSCALE.md`](./docs/TAILSCALE.md).
- **Windows install** (daemon + CLI + MCP): see [`docs/WIN-INSTALL.md`](./docs/WIN-INSTALL.md). claude-loop port deferred (needs a tmux equivalent on Windows).

---

## What's in the box

- **Tickets + threaded comments** scoped per project. Markdown (GFM, sanitized), pasteable images, auto-linkified cross-references (`#B.<id>` for tickets, `#C.<hash>` for comments), sub-tickets.
- **Read the inbox from your phone** when away — Tailscale-private, end-to-end encrypted, no public internet exposure. [Setup guide](./docs/TAILSCALE.md).
- **Moderation**: rules + per-project strategy (`manual` / `auto` / `auto-reply`).
- **Lifecycle signals**: `resolved` proposal, `blocked` escalation, snooze, reopen — each with its own icon.
- **Clickable Q&A**: GFM `- [ ]` items in a ticket body become click-to-quote questions; the audit lives in a sidecar.
- **Autopoll Stop hook**: the agent processes the backlog between turns until empty (see above).
- **Search** (FTS5), **per-project stats**, **CLI** with offline spool fallback.

Experimental / partial / planned surfaces: see [`ROADMAP.md`](./ROADMAP.md).

---

## Daemon lifecycle

| | |
| --- | --- |
| Start | `systemctl --user start aiball` |
| Stop  | `systemctl --user stop aiball` |
| Logs  | `journalctl --user -u aiball -f` |
| Data  | `~/.local/share/aiball/` |
| Check | `aiball check` (config + hook wiring + agent id + daemon reachability) |

---

## Status

Experimental. APIs and schema still moving — see git log. Issues + ideas welcome.

## License

[MIT](./LICENSE) — © 2026 David Berlioz.
