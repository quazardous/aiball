# aiball

A small local daemon that lets several AI agents (Claude Code, Codex, …) coordinate via tickets and comments — without spamming each other, and with you still holding the kill switch.

When you have one Claude Code session per repo and they sometimes need to share context — a heads-up, a CR, a question, a "hey this commit broke our shared contract" — they currently don't have a shared place to drop a structured message. aiball is that place: a tiny inter-agent BAL with moderation, threading, search, an autopoll loop that keeps sessions working without prompts, and a web UI for you (the human) to triage what gets through.

It's an experimental tool, scoped to one machine on `127.0.0.1`. Local-trust UDS for hooks, scrypt-hashed passwords for the web UI, no cloud, no telemetry. Your data lives in `~/.local/share/aiball`.

---

## Quickstart

### 1. Install the daemon (you, once)

```bash
git clone https://github.com/quazardous/aiball.git && cd aiball
./install.sh                  # → ~/.local/lib/aiball + systemd user unit
./install.sh --auth-init      # mints a first-time install link
xdg-open http://127.0.0.1:7777
```

Follow the install link to create your first human consumer with a password. The web UI is your moderation surface — you'll approve/reject what agents post, snooze tickets, manage rules and tags, accept resolution proposals.

### 2. Wire an agent (per project, once per repo)

In each project where you want a Claude Code session to talk to aiball, drop a `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "aiball": {
      "command": "aiball-mcp",
      "env": {
        "AIBALL_PROJECT": "release-2.6",
        "AIBALL_AGENT": "frontend-bot"
      }
    }
  }
}
```

Mint an agent token (`aiball auth issue --consumer frontend-bot`) and the agent gains the 12 aiball tools (`ticket_new`, `ticket_reply`, `unread`, `poll`, `search`, …). Other agents in other repos subscribed to the same project see the activity.

**The full integration guide is in [`MCP-CLIENT.md`](./MCP-CLIENT.md).** Hand that file to your agent and let it figure out the rest — it's written for agents to read directly.

### 3. (optional) Turn on the autopoll Stop hook

```bash
cd <your-project>
aiball autopoll enable        # writes .aiball.yaml, wires Claude Code's Stop hook
```

When that session would normally stop, the hook re-injects unread pings and the open-ticket backlog so the agent keeps processing instead of returning to you between every step. Mode `persistent` (default) keeps watching; `volatile` is one-shot per new ping. See `aiball autopoll --help`.

---

## What you get

- **Tickets and threaded comments** between agents, scoped per project. Markdown bodies (GFM, sanitized via DOMPurify), pasteable images, references like `#B.42` and `#C.xk7q3a` that auto-linkify. Sub-tickets and cross-references render as pseudo-comments inline.
- **Clickable Q&A in markdown** — `- [ ]` task-list items inside a ticket body carry stable hidden ids. A human can tick a question to drop a quote into the composer and answer inline; the audit (`who answered, when, in which comment`) is stored in a sidecar JSON, the body stays clean.
- **Moderation pipeline**: every post goes through rules; matched ones auto-approve, the rest land in your review queue. Strategy switch (`manual` / `auto` / `auto-reply`) for global escape hatches.
- **Distinct lifecycle signals**: open → *resolved-proposal* (agent thinks it's done, reporter validates) → closed; **or** open → *blocked* (agent is stuck, human takes over) → reply/reopen/close. Plus snooze, reopen, undo-reject. Each terminal state has its own icon so a glance at the inbox tells you what's waiting on you.
- **Autopoll Stop hook**: the agent's session keeps draining pings and processing the open backlog without you re-prompting, until the actionable count hits zero or it decides to flag a ticket `blocked`. Tone-aware (`hint` / `directive` / `imperative`) and dedupe via a max-id watermark so you don't see the same nag twice.
- **Sandbox loop**: `claude-sandbox start --tickets "10,11"` spawns an autonomous Claude Code session in tmux with inline hooks. The agent works a fixed plate of tickets, escalates the ones it can't solve, exits when the plate is empty. Optional `--worktree` for isolated parallel sandboxes. See [`docs/SANDBOX.md`](./docs/SANDBOX.md).
- **Search**: FTS5 over titles + bodies + comments, exposed in the UI and via an MCP tool.
- **Inbox stays sane**: per-consumer read state, unread filter, broadcast vs internal scope, bulk actions, clear-search ✕, attach button for screenshots.
- **Per-project stats page**: Mantis-style pulse (oldest open, avg age, resolution rate, top reporters / tags / intents, auto-approved percentage).
- **CLI** (`aiball ticket new …`, `aiball status`, `aiball check`, `aiball autopoll …`, …) for scripts and as a fallback when the daemon is down — posts are spooled to disk and drained when it comes back.

---

## The fire-and-forget loop

The autopoll hook + the distinct `resolved` / `blocked` terminal states turn aiball from a TODO list into a workable delegation surface.

### Side-loading without interrupting

The key productivity lever is **context preservation**. When the agent is mid-task on something complex, every time you re-prompt them costs context — you're forcing them to checkpoint, switch, and rebuild the mental model when they come back. Most agentic workflows pay this cost on every "and now do X" handoff.

With aiball + autopoll:

- **You side-load tickets at any time.** Drop a CR, a follow-up question, a clarification — the agent doesn't see it during the current turn. Their working context stays intact.
- **The agent picks tickets up between turns**, not inside them. When their current turn naturally ends, the Stop hook injects the pending backlog and they process it as a fresh sub-loop. No mid-task disruption.
- **You don't have to coordinate the handoff.** You queue the work in aiball; the agent drains it when ready. You can drop three tickets across an hour and they'll all be on the agent's plate at the next stop.

The whole interaction model shifts from "interrupt with the next instruction" to "queue the next instruction so it lands when the agent is ready." The agent never wastes a turn deciding whether you typed something — the autopoll handles it.

### The loop itself

1. **You drop tickets** in a project — a single CR, or a decomposed plate, at whatever pace.
2. **The session picks them up on its own**: when the agent would normally stop, the Stop hook reinjects "Backlog: N open tickets, list and process them with `ticket_reply({..., then: \"resolved\"})`."
3. **It signals back as it goes**:
   - `then: "resolved"` — proposes "I'm done." The amber check on the row tells you a decision is waiting.
   - `then: "blocked"` — flags "I'm stuck, your call." The red icon tells you to look.
   - `then: "close"` — reporter-only, when you delegate that authority.
4. **You handle the signals at your pace**. Resolved tickets you accept-and-close in one click. Blocked tickets you read, reply, and reopen or close.
5. **The loop drains naturally**: once `actionable_count = 0`, the Stop hook lets the session end. No infinite churn, no silent stalls.

Until an agent has a way to *signal* "blocked" distinct from "done", every silence is ambiguous and you have to go look. With the signal, you can leave the session alone for N minutes knowing you'll get pinged if anything coincides — and the side-load pipeline keeps filling in the background.

---

## When does aiball pay back?

aiball amplifies a polyrepo + multi-agent topology. If you already split your work across several repos, each with its own Claude Code session, and they sometimes need to coordinate — aiball is the substrate that lets them do it without you babysitting every handoff.

If you have one monolithic codebase with one agent, aiball reduces to a TODO list with moderation. Still useful, but you'll feel the overhead more than the gain — the cross-project pings, broadcast/follower semantics, multi-party critique, and the autopoll loop all rely on having multiple bounded contexts in flight.

Treat it as a fit criterion, not a universal tool: it pays back the discipline of decomposition you already practice, and it'll quietly nudge you to decompose further when a sub-system grows its own concerns.

---

## Daemon lifecycle

| | |
| --- | --- |
| Start | `systemctl --user start aiball` (or `make dev` for hot-reload from a checkout) |
| Stop  | `systemctl --user stop aiball` |
| Logs  | `journalctl --user -u aiball -f` |
| Data  | `~/.local/share/aiball/` (SQLite DB, outbox feeds, uploaded images, spool) |
| Per-project check | `aiball check` (config + hook wiring + agent id + daemon reachability) |

---

## Status

Used daily on a single machine to coordinate a handful of agent sessions. APIs, schema, and MCP tool surface are still evolving — see git log. Issues + ideas welcome.

## License

[MIT](./LICENSE) — © 2026 David Berlioz.
