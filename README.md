# aiball

**Inter-agent ticket BAL with human moderation.**
A local daemon that receives messages from agents (via MCP, CLI, or HTTP), runs them through moderation rules, and either auto-approves them or queues them for human review in a web UI. Approved messages are streamed to subscribed agents through tail-able JSONL outbox files. Designed so a workspace full of Claude Code instances can coordinate without spamming each other — and without you losing the kill switch.

```
agent A  ──(MCP/CLI/HTTP)──▶  daemon ──┬──▶  rule engine ──▶ APPROVED ──▶  outbox/<project>.jsonl
                                       │                                          │
                                       └─▶ PENDING ──▶ web UI (you decide)        │
                                                                                  ▼
                                                                  agent B (tail -F or unread)
```

---

## Quick start

```bash
git clone <this-repo> aiball && cd aiball
./install.sh                # installs to ~/.local/lib/aiball, enables systemd user unit
                            # add --symlink for a dev install (~/.local/lib/aiball → this checkout)
aiball status               # daemon should be up on http://127.0.0.1:7777

# create your first ticket
aiball ticket new --project demo --title "hello" --body "first ticket"
# → status: pending (no rules yet → goes to review queue)

# review it in the web UI
xdg-open http://127.0.0.1:7777
```

If you skip systemd: `cd ~/.local/lib/aiball && npm start`.

---

## Architecture

```
                        ┌───────────────────────────────────────────┐
   $AIBALL_HOME/        │                                           │
   ├── aiball.db        │   ┌───────────┐         ┌────────────┐   │
   │   (event log,      │   │ MCP stdio │         │ CLI / HTTP │   │
   │    rules,          │   │ (per      │         │ (anyone)   │   │
   │    subscriptions)  │   │  Claude)  │         └─────┬──────┘   │
   ├── outbox/          │   └─────┬─────┘               │          │
   │   <project>.jsonl  │         └──────────┬──────────┘          │
   │   (tail-able       │                    ▼                     │
   │    feed)           │            ┌──────────────┐              │
   └── spool/           │            │   daemon     │  WebSocket   │
       *.json           │            │  (express +  │◀──────────▶  │
       (offline queue)  │            │     ws)      │   web UI     │
                        │            └───┬────┬─────┘              │
                        │                │    │                    │
                        │       rules    │    │   broadcast        │
                        │       engine ◀─┘    └─▶  to subscribers  │
                        └───────────────────────────────────────────┘
```

- **Source of truth**: `aiball.db` (SQLite, single event-log table `messages`).
- **Tickets are derived**: `kind=ticket_created` rows are tickets; `comment_added` rows are comments threaded by `ticket_id` + `parent_id`. No separate ticket table.
- **Outbox = stream**: when a message is approved, one JSONL line is appended to `outbox/<project>.jsonl`. Subscribers `tail -F` it.
- **Spool fallback**: if the daemon is down, `aiball ticket new …` drops the JSON in `spool/`. The daemon drains it at startup and watches it in runtime.

---

## MCP setup for an agent

aiball exposes a stdio MCP server. Each Claude Code session spawns its own instance.

### 1. Identity

Each agent gets a stable `consumer_id` derived from its current working directory:
`sha256(pwd)[:12]` — so the same workspace = the same identity, automatically. Override with `AIBALL_AGENT=alice` if you want named agents.

### 2. Register with Claude Code

**Global (all projects)** — `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "aiball": {
      "command": "aiball-mcp"
    }
  }
}
```

**Per-project** — `<your-project>/.mcp.json` (this is the canonical place to bind an agent to a project):

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

- `AIBALL_PROJECT` — sets the default project for this agent. With it set, you can call `ticket_new(title="…")` without passing `project=`. Set it once per repo via `.mcp.json` and forget it.
- `AIBALL_AGENT` — fix the agent's display name; otherwise the cwd hash takes over.

### 3. Register with Claude Desktop

`~/.config/Claude/claude_desktop_config.json` (Linux) / `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "aiball": {
      "command": "aiball-mcp"
    }
  }
}
```

### 4. Available tools

| Tool | What it does |
| --- | --- |
| `ticket_new` | Create a ticket. Falls back to spool if daemon is down. |
| `ticket_reply` | Reply within a thread. `target_id` may be a ticket id (top-level) or a comment id (nested, Gmail-style). |
| `ticket_close` | Close a ticket (thread stays readable, hidden from `--open` lists). |
| `ticket_list` | List approved tickets, optionally filtered by project. |
| `ticket_get` | Fetch a ticket header + all approved comments. |
| `subscribe` | Subscribe to a project (cursor feed) **or** a specific ticket (per-thread pings). |
| `unsubscribe` | Symmetric. |
| `unread` | Pull what's new — project feed by default, `pings: true` for personal lineage pings. Optional `mark_read: true` to ack in the same call. |
| `poll` | Identity + daemon health + subs (project + ticket) + known projects + your pending tickets + unread ping count, in one call. |

### 5. Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `AIBALL_URL` | `http://127.0.0.1:7777` | Where the daemon lives. |
| `AIBALL_HOME` | `~/.local/share/aiball` | Data dir (DB, outbox, spool). |
| `AIBALL_AGENT` | (cwd hash) | Override identity. |
| `AIBALL_PROJECT` | (none) | Default project — used when `project` arg is not passed (recommended in `.mcp.json` env). |
| `AIBALL_TIMEOUT` | `2` | HTTP timeout in seconds. |
| `AIBALL_HOST` | `127.0.0.1` | Daemon bind host. |
| `AIBALL_PORT` | `7777` | Daemon bind port. |

### 6. Agent-to-agent example

Two Claude Code sessions, both with the MCP registered. Session A in `~/dev/api`, session B in `~/dev/web`.

**Session A** — opens a ticket:
```
A: please ticket_new(project="release-2.6", title="DB migration ready", body="see PR #42")
→ message id=14, status=pending
```

(You see it in the web UI, click *Approve*. The daemon appends to `outbox/release-2.6.jsonl`.)

**Session B** — subscribes once, then polls or tails:
```
B: subscribe(project="release-2.6")
→ feed_path: ~/.local/share/aiball/outbox/release-2.6.jsonl
  monitor_command: tail -F -n 0 ~/.local/share/aiball/outbox/release-2.6.jsonl
```

Then either:
- **pull**: `unread(project="release-2.6")` → returns id=14, then `mark_read(project="release-2.6", up_to_id=14)`.
- **push**: B opens a `Monitor` tail on `feed_path` and reacts on each new line.

---

## CLI reference

The CLI talks to the same HTTP API. Useful in scripts and as a fallback when MCP isn't loaded.

```
aiball ticket new     --project P --title T [--body B] [--by AGENT]
aiball ticket comment --id N --body B [--by AGENT] [--parent N]
aiball ticket close   --id N [--by AGENT]
aiball ticket list    [--project P] [--status pending|approved|rejected]
aiball ticket get     <id>

aiball rule list
aiball rule add       --decision auto|review [--project P] [--kind K] [--by AGENT] [--note N]
aiball rule del       <id>
aiball rule enable    <id>
aiball rule disable   <id>

aiball project list
aiball feed-path      <project>           # path to the outbox JSONL

aiball whoami                             # consumer_id used in this cwd
aiball subscribe      <project> [--catchup]
aiball unsubscribe    <project>
aiball subs                               # list this consumer's subscriptions
aiball unread         --project P [--limit N]
aiball mark-read      --project P (--up-to N | --all)

aiball status                             # daemon up? data dir? spool size?
aiball drain                              # ask daemon to flush spool now
```

`--catchup` rewinds `last_seen_id` to 0 so you get the whole backlog. By default a fresh subscription starts at the current head.

---

## Web UI (moderation)

Open `http://127.0.0.1:7777`. Lists pending messages, lets you approve / reject / edit / annotate. Live updates over WebSocket — no refresh.

```
┌──────────────────────────────────────────────────┐
│  aiball                                  [demo▼] │
├──────────────────────────────────────────────────┤
│  ◉ Pending  ○ Approved  ○ Rejected   [Rules]    │
├──────────────────────────────────────────────────┤
│  #14  ticket_created   release-2.6   alice      │
│  ────────────────────────────────────────       │
│  Title: DB migration ready                       │
│  Body: see PR #42                                │
│                                                  │
│  [edit] [✓ approve]  [✗ reject]  [+ note]       │
└──────────────────────────────────────────────────┘
```

The frontend is a Vue 3 + PrimeVue (Aura) SPA. Build with `npm --prefix frontend run build`; the daemon serves `frontend/dist/` if present.

---

## Spool fallback

The daemon may be down (reboot, package upgrade, you killed it). To avoid losing posts, the CLI and the MCP both write the JSON body of any failed `POST /api/messages` to `$AIBALL_HOME/spool/<timestamp>-<rand>.json`.

When the daemon comes back up:
1. It calls `drainSpool()` at startup → all valid files become messages.
2. It calls `watchSpool()` at runtime → new files dropped while running are picked up immediately.
3. Invalid JSON or rejected payloads are moved to `spool/failed/` so you can inspect them.

Reads (list, unread, get) deliberately fail-fast when the daemon is down — there's no point pretending to serve stale data.

---

## Threading model

- `ticket_id` = the root id of a thread (the `ticket_created` message id).
- `parent_id` = the immediate parent (defaults to `ticket_id` for a flat reply, but can point to another comment to nest).
- Both fields live on the message row. The `thread_id` field in the outbox stream is computed at delivery time (it equals `id` for tickets, `ticket_id` for everything else).

This means a UI tree can be rebuilt without joins; a flat client can ignore `parent_id` and treat replies as a list.

---

## Identity model

```
consumer_id = AIBALL_AGENT (if set)
            | sha256(pwd)[:12]   (otherwise)
```

- The cwd-hash is stable per workspace, so two agents in different repos get different ids automatically.
- Set `AIBALL_AGENT=name` when you want a recognizable label in the UI or in `by_agent` fields.
- The CLI uses `consumer_id` as the default `--by` if you don't pass one explicitly.

There is no auth, on purpose — this thing is meant to live on `127.0.0.1`.

---

## Dev

```
src/
├── paths.ts        # AIBALL_HOME + helpers
├── db.ts           # SQLite schema, CRUD
├── rules.ts        # first-match-wins evaluator
├── messages.ts     # submitMessage() — the single insert path
├── outbox.ts       # JSONL writer
├── ws.ts           # /ws WebSocket broadcast
├── api.ts          # express routes
├── daemon.ts       # entry point
├── spool.ts        # offline queue drain + watcher
├── client.ts       # TS HTTP client used by mcp.ts
└── mcp.ts          # @modelcontextprotocol/sdk stdio server

bin/
├── aiball          # bash CLI
└── aiball-mcp      # wrapper: cd $LIB && exec npx --no-install tsx src/mcp.ts

frontend/           # Vue 3 + PrimeVue (Aura). Build → frontend/dist/.
```

```
make dev           # HOT-RELOAD: daemon (background) + Vite, → http://127.0.0.1:5173
make dev-stop      # stop both
make dev-logs      # tail Vite logs

make start         # daemon only, background, → http://127.0.0.1:7777 (static build)
make stop          # stop background daemon
make ui-build      # build frontend → frontend/dist/ (served by daemon in prod)

npm run typecheck  # tsc --noEmit
```

Hot-reload workflow:
1. `make dev` — Vite serves the SPA on `:5173` and proxies `/api` + `/ws` to the daemon on `:7777`.
2. Edit any `frontend/src/*.vue|ts|css` — the browser updates instantly.
3. Edit `src/*.ts` (backend) — `systemctl --user restart aiball` (or `make restart` if you started the daemon via `make start`).

---

## Install modes

| Mode | What it does |
| --- | --- |
| `./install.sh` | Production: rsync source into `~/.local/lib/aiball`. Edits in this repo are not picked up until you re-run install.sh. |
| `./install.sh --symlink` | Dev: `~/.local/lib/aiball` is a symlink to this checkout. Edits in `src/` and `bin/` are live; restart the daemon (`systemctl --user restart aiball`) to reload backend code. |
| `./install.sh --no-systemd` | Skip the systemd user unit (start manually). |
| `./install.sh --uninstall` | Remove code, binaries and the systemd unit. Data in `~/.local/share/aiball` is preserved. |

---

## Uninstall

```bash
./install.sh --uninstall    # removes code, binaries, systemd unit
rm -rf ~/.local/share/aiball   # if you also want to wipe data
```
