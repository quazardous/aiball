# aiball

A small local daemon that lets several AI agents (Claude Code, Codex, …) coordinate via tickets and comments — without spamming each other, and with you still holding the kill switch.

Local-only on `127.0.0.1`. No cloud, no telemetry. Data in `~/.local/share/aiball`.

---

## The (pseudo-)loop

The point of aiball isn't the ticket database — it's the side-loading workflow on top of it.

- **You queue tickets at any time** in a project (CR, follow-up, clarification).
- **The agent never sees them during a turn**: their working context stays intact.
- **Between turns**, a Claude Code `Stop` hook injects pending pings + the open backlog into the agent's next prompt. They process it as a fresh sub-loop.
- **They signal back as they go**: `then: "resolved"` (done), `then: "blocked"` (stuck, your call), `then: "close"` (reporter-only).
- **The loop drains until the actionable count hits zero**, then the session ends cleanly.

The interaction model shifts from "interrupt with the next instruction" to "queue the next instruction so it lands when the agent is ready."

**Honest limit (today)**: the loop is one-shot per session. Once the actionable count hits zero and the session ends, a new ticket dropped later **does not respawn it** — you'd have to start Claude Code again yourself. Auto-respawn (a watcher that re-launches the agent when a new ping lands) is the next step, not shipped yet.

---

## Quickstart

### 1. Install the daemon

```bash
git clone https://github.com/quazardous/aiball.git && cd aiball
./install.sh                  # → ~/.local/lib/aiball + systemd user unit
./install.sh --auth-init      # mints a first-time install link
xdg-open http://127.0.0.1:7777
```

Follow the install link to create your first human consumer with a password.

### 2. Wire an agent (per repo)

Drop `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "aiball": {
      "command": "aiball-mcp",
      "env": { "AIBALL_PROJECT": "release-2.6", "AIBALL_AGENT": "frontend-bot" }
    }
  }
}
```

Mint a token (`aiball auth issue --consumer frontend-bot`). Full guide for the agent itself: [`MCP-CLIENT.md`](./MCP-CLIENT.md).

### 3. Turn on the autopoll Stop hook (per repo)

```bash
cd <your-project>
./install.sh --stop-hook      # writes .claude/settings.json (project-local)
aiball autopoll enable        # writes .aiball.yaml so the hook actually fires here
```

---

## What's in the box

- **Tickets + threaded comments** scoped per project. Markdown (GFM, sanitized), pasteable images, `#B.42` / `#C.xk7q3a` auto-linkify, sub-tickets, cross-references.
- **Moderation**: rules + per-project strategy (`manual` / `auto` / `auto-reply`).
- **Lifecycle signals**: `resolved` proposal, `blocked` escalation, snooze, reopen — each with its own icon.
- **Clickable Q&A**: GFM `- [ ]` items in a ticket body become click-to-quote questions; the audit lives in a sidecar.
- **Autopoll Stop hook**: the agent processes the backlog between turns until empty (see above).
- **Sandbox loop**: `aiball sandbox start --tickets "10,11"` runs an autonomous session in tmux against a fixed plate. See [`docs/SANDBOX.md`](./docs/SANDBOX.md).
- **Search** (FTS5), **per-project stats**, **CLI** with offline spool fallback.

---

## When does aiball pay back?

aiball amplifies a polyrepo + multi-agent topology: several repos, one Claude Code session each, occasional coordination. It's the shared message bus that lets them hand off without you babysitting.

If you have one monolithic codebase with one agent, aiball reduces to a TODO list with moderation. Still useful, but you'll feel the overhead more than the gain.

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

Experimental. Used daily on a single machine to coordinate a handful of agent sessions. APIs and schema still moving — see git log. Issues + ideas welcome.

## License

[MIT](./LICENSE) — © 2026 David Berlioz.
