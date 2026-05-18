# Changelog

Notable changes to aiball — the MCP surface, HTTP API, UI, and CLI.

**Style**: human-friendly, synthetic. Each entry is a short paragraph or a
handful of bullets describing what changed for users / integrators, not a
file-by-file diff. If you want details, see the linked tickets or
`git log`. Dates are YYYY-MM-DD; format inspired by Keep a Changelog.

Multi-component changes get listed under one date even when individual
versions diverge — qcmp.yaml tracks per-component versions; this file is
the human-readable narrative.

---

## [Unreleased]

_Nothing yet._

## [0.6.2] - 2026-05-18

### No more "faux unread" on the human's own posts (`#B.191`)

Posting from the web UI as a display alias (e.g. "as david")
used to ping the registered `human` Moderator consumer — the
same person under a different identity — and surface the author's
own posts as unread. fanOutPings now skips cross-human pings; a
one-shot migration (`0016_dedupe_cross_human_pings`) backfilled
the existing rows. Agent → human pings are unchanged.

### Remote access from your phone via Tailscale (`#B.182`)

aiball can now be reached from your phone (or any tailnet device)
without exposing the daemon to the public internet.

- New `bin/aiball-tailscale` helper wraps `tailscale serve` with
  the daemon port auto-resolved. `up` / `down` / `status`
  subcommands; HTTPS on :443 by default, `--http` fallback when
  MagicDNS HTTPS certs aren't enabled.
- New `docs/TAILSCALE.md` quickstart covering both host (install
  Tailscale + run helper) and client (install the app on
  phone/desktop, sign in to the same account, enable VPN, open
  URL).
- `install.sh` symlinks the helper alongside `aiball`.

aiball auth (password / bearer) is unchanged — Tailscale handles
the transport, the middleware still fires.

### README pre-publication polish (`#B.183`, `#B.189`)

The "sandbox loop" / autonomous-multi-agent narrative was framing
aiball as something it isn't yet — moved to a new `ROADMAP.md`,
README trimmed to current shipping features. Internal ticket refs
stripped from user-facing copy. Mobile/Tailscale flow surfaced in
"What's in the box".

### Mobile UI fixes (`#B.187`, `#B.188`)

Two cuts after testing the new mobile flow:

- Toast notifications now sit at the bottom on phone with proper
  margins (the mobile CSS block had the wrong media query and
  never fired).
- New-ticket form: title + intent select stack vertically below
  720px instead of overflowing off the right edge.

### claude-loop: all timeouts yaml-configurable (`#B.180`)

New `claude_loop:` block in `.aiball.yaml` exposes the heartbeat
tick and grace windows (`interval_seconds`, `boot_grace_seconds`,
`user_grace_seconds`, `wake_in_flight_ttl_ms`). Fixed alongside:
the loop's own auto-wake `send-keys` no longer self-triggers
user-grace (it had been locking the wrapper out until a real
human keystroke arrived).

### claude-loop: tmux clipboard via local tool with OSC 52 fallback (`#B.181`)

Drag-select in a claude-loop pane now copies to the system
clipboard. Pipes through `wl-copy` / `xclip` / `pbcopy` when
available (fixes VTE terminals like Ptyxis that reject OSC 52);
OSC 52 stays as the SSH/remote fallback. Shift+drag still works
as the no-tmux escape hatch.

### claude-loop: status bar no longer stuck on `busy` (`#B.185`)

After a few turns the bar could get pinned on `busy` even when
Claude was idle, because the Stop hook re-probed the pane for
"esc to interrupt" and matched stale footer text from the
just-finished turn. The probe is now scoped to the live footer
and the obsolete `working` pane-state was retired. Default
heartbeat tick `interval_seconds` also dropped from 60s → 30s
(the bar was lagging visibly behind real state changes);
`user_grace_seconds` recalibrated from 300s → 60s (5-minute
outlier; one keystroke silenced the wrapper for 5min).

### Inbox: default to "all" status + reset-from-empty filter (`#B.184`)

The inbox defaulted to `pending`, which on auto-approve projects
(aiball itself) landed users on an empty list while the sidebar
badges showed dozens of open tickets. Now defaults to `all`;
empty rows offer a "Show all open tickets" reset button when
filters are narrowed.

### Main branch protected (`#B.186`)

GitHub ruleset on `quazardous/aiball` blocks force-push and
deletion on `main`. Direct-push workflow unchanged.



The consumers panel now shows two new pieces of information per row:
last-seen (relative time since the consumer's last API call) and, for
claude-loop agents, a live state badge — `busy` (electric blue,
matches the tmux bar), `boot` (yellow), `idle` (gray), or `offline`
(gray, no heartbeat in the last 60s).

- Backend: `last_seen_at` touched in the auth middleware on every
  authenticated request. New `PUT /api/consumers/:id/state` endpoint
  for claude-loop's timer to push its `settledStatus` on each tick
  (own-state only — humans rejected, the badge surface is for loop
  agents).
- Frontend: new "Activity" column in `ConsumersPanel.vue` with a
  tick-clock for relative-time freshness (no re-fetch) plus a full
  re-fetch every ~30s. Existing "State" column renamed to "Active"
  (it's the enable/block toggle). Column headers are clickable to
  sort by id / kind / display name / activity / active.
- Migration: 0015 adds `last_seen_at`, `state`, `state_since`,
  `state_updated_at` to the consumers table.

### Project bootstrap CLI (`#B.175`)

Three new commands consolidate the per-project wiring:

- `aiball mcp init` — merges the aiball entry into `.mcp.json`
  non-destructively (preserves any existing MCP servers, idempotent,
  `--force` rewrites to canonical form which drops the legacy
  `mcpServers.aiball.env` block per #B.154).
- `aiball autopoll init` — copies the annotated `.aiball.yaml`
  template (already shipped, unchanged here).
- `aiball init` — Quickstart wrapper. Calls `mcp init` then writes
  a minimal `.aiball.yaml` (`autopoll: enabled: true`).

README Quickstart §2 now a single line: `aiball init`.

### Tmux mouse mode in claude-loop sessions (`#B.176`)

`claude-loop start` now sets `mouse on` per-session (scoped, no
`.tmux.conf` impact). Scroll wheel scrolls the pane buffer instead
of getting translated to Up/Down arrow keys.

### Unified identity resolution chain (`#B.154`)

`.aiball.yaml consumer.*` is now the canonical source for `consumer_id`
and default project across every aiball surface (autopoll, claude-loop,
`aiball` CLI, MCP server). The chain, applied entirely in
`src/autopoll/config.ts:loadConfig()`:

1. `process.env.AIBALL_AGENT` / `AIBALL_PROJECT` — priority override
   for special cases
2. `.aiball.yaml consumer.agent` / `consumer.project` — canonical
3. `.mcp.json mcpServers.aiball.env.*` — DEPRECATED (still works,
   `aiball check` + `claude-loop` warn on stderr)
4. Defaults: project = `basename(cwd)`; agent = `<project>-claude`

`aiball check` now surfaces the source of each resolved field
(`[from aiball.yaml/env/mcp.json/default]`), a dedicated
`deprecation` section when `.mcp.json` carries the legacy env block,
and an activation hint (`activate with: aiball autopoll init`) when
the Stop hook is wired but no `.aiball.yaml` is present.

Migration: drop the `mcpServers.aiball.env` block from `.mcp.json`,
add a `consumer:` block to `.aiball.yaml`. See `.aiball.yaml.example`.

### claude-loop status & pane awareness (`#B.154`)

- **Status colors** in the tmux bar: `[boot]` (yellow) → `[idle]` (gray)
  → `[busy]` (cyan, queued/waiting) → `[working]` (green, claude
  actively mid-turn per `esc to interrupt`). Plus phase suffixes
  `[busy:compacting]` / `[busy:rate-limit]` / `[busy:api-error]` and
  resume picker phases (`[boot:resume?]`, `[boot:pick→as-is]`, …).
- **Resume picker auto-dismiss** on `--resume`: SessionStart hook
  detects the picker text and sends Down+Enter (or Enter, per
  `CL_RESUME_MODE`).
- **Heartbeat pane-probe**: every tick the timer reads pane content
  and flips the bar between `working` ↔ `idle` based on
  `esc to interrupt`. Catches the case where Claude Code's Stop hook
  doesn't fire (slash commands like `/compact`), so the bar no longer
  sticks at `[busy]` after a slash command returns.
- **Bootstrap refactor**: new `ProjectContext` service centralizes
  cwd + identity resolution for cmdStart / cmdCheck / cmdTrace
  (previously duplicated with subtle drift).

### Rejected decisions surfaced in the inbox (`#B.168`, `#B.173`)

When the reporter rejects an agent's resolution proposal and the
thread stays open, the row now shows a red × badge
(`rejected-resolved`) so the reporter sees "I rejected, work still
on the table". Same surface for plan decisions
(`rejected-plan`, amber `pi-ban` badge — distinct from agent-
escalation red).

Latest-wins semantics: a fresh proposal supersedes prior rejected
ones on the badge. Cleared once the ticket is closed or rejected.

### SSE event-bus — daemon push, kill the polling lag (`#B.148`)

The daemon now exposes a Server-Sent-Events stream at
`GET /api/events?consumer_id=X`. New ping insertions emit a `ping` event
to every subscriber for that recipient in real time (sub-10ms end-to-end
in smoke tests, FIFO-ordered, no drops).

- **Daemon side**: `src/event-bus.ts` (typed EventEmitter), `insertPing`
  emits on successful insert (skips `onConflictDoNothing` duplicates),
  `/api/events` endpoint with `hello` boot frame + 30s keepalive + clean
  teardown on close/error.
- **Client side**: `AiballClient.subscribeEvents({onPing, onHello?,
  onError?}): unsubscribe` opens an SSE stream over UDS, parses frames,
  invokes callbacks. No built-in reconnect — caller decides.
- **claude-loop timer** now picks SSE mode automatically when the
  check-cmd is the default `aiball pings-count -q`. Wake fires
  ~immediately on a new ping. Heartbeat (interval) stays as a safety
  net for `wake-requested` files + SSE-drop reconnect. Custom check-cmds
  keep the legacy polling loop.

Latency before: worst-case `CL_INTERVAL` (60s default). Latency after:
~1ms (DB insert → emit → SSE flush → wake).

### claude-loop diagnostic toolkit (`#B.149`, `#B.154`)

Two new subcommands to debug "loop stays idle, why?" without spawning a
claude session:

- `claude-loop check [name]` — one-shot report: resolved consumer_id,
  unread pings count, project subscriptions, verdict (WAKE/SLEEP), plus
  contextual hints when AIBALL_PROJECT is set but the consumer has no
  subscription on it.
- `claude-loop trace [--events] [--once] [--interval N]` — foreground
  gate evaluator. Default prints WAKE/sleep every N seconds. `--events`
  opens SSE and tails every incoming event raw (no claude, no tmux —
  pure observation).

`bin/claude-loop` launcher now resolves `AIBALL_SOCK` (same logic as
`bin/aiball`), so `claude-loop check` works standalone without the
daemon's auth-via-token path.

### claude-loop SessionStart matcher fix (`#B.148`)

Hook matcher was `"startup"` only, so `claude --resume` (matcher
`"resume"`) and `claude --continue`/`/clear` (matcher `"clear"`) skipped
the boot drain entirely. Combined with SSE only delivering NEW pings
(existing unread don't replay at connect), loops stayed `[idle]` after
resume even with work waiting. Fix: register the hook against the three
matchers (array form). Plus the timer now does an immediate `tryWake`
right after subscribing, as a defensive catch-up when SessionStart
misses.

Also: `claude-loop start --user-grace <sec>` CLI option (`#B.145`),
inline `UserPromptSubmit` hook refreshing a `user-took-over` marker; the
timer skips wakes while the marker is fresh (default 300s) so the
wrapper doesn't send-keys over a human-driven prompt.

### Mobile-responsive UI pass (`#B.161`, `#B.150`, `#B.158`, `#B.159`, `#B.165`)

First-pass mobile readiness for tailscale/phone access. Audited live at
500px viewport, fixed several breaks:

- **Header** wraps on narrow viewports (was clipping the strategy
  dropdown). At <720px: strategy select hidden (accessible via Project
  Settings), badges compacted, h1 smaller, spacer collapsed. All
  controls visible on at most two rows.
- **Sidebar** projects list collapses to a CSS `<details>` dropdown on
  mobile (open by default on desktop). Settings section becomes a
  horizontal icon-row pushed to the bottom of the sidebar band —
  matches david's "settings should read as footer" intent without
  splitting the component.
- **Toasts** go edge-to-edge with detail footer hidden on mobile (the
  summary already carries the kind + ref).
- **Consumers panel** border-bottom now aligns across all cells on
  every row (was a 7px drift from a leaked `display: flex` rule in
  ProjectsPanel — scoped selectors with `.consumers-table` prefix fix
  it).
- **Relation-promote popover** survives navigation no more — Popover
  state hidden + reset on `ticketId` watcher. Plus an explicit close X
  button top-right.

### ticket_referenced dedupe (`#B.153`)

`insertRelationEvent` now skips inserting a `ticket_referenced` row
when one already exists for the same (target, source) pair — fixes the
"referenced from #B.NN, #B.NN" rendering noise when a source ticket
edits or re-mentions the same target across multiple comments.

### README + hero image (`#B.157`)

- New title: `aiball — local backlog for inter-agent coordination`
- Hero diagram at the top (`assets/aiball-loop.png`)
- Pseudo-loop section rewritten with the SSE + claude-loop + MCP
  primitives now shipped
- "Two key innovations" (decision-on-comment + SSE event-bus) +
  "Useful primitives for Claude Code users" + "Why not slack-bot" sub-
  sections aligned with the diagram
- GitHub repo description updated to match

### claude-loop — new generic tickable wrapper (`#B.63`)

`claude-loop` wraps a Claude Code session in a tmux loop that wakes itself
when idle. Built generic but ships aiball-aware by default — the timer
checks `aiball pings-count` each tick and pings claude only when there's
work to drain (no unnecessary nags). Pure timer mode still available via
`--check-cmd true`. Direct in-process AiballClient call when using the
default check (no fork per tick).

Defaults: spawn + attach + random pop-culture wake-up phrase ("Hello,
Dave." / "Make it so." / "Allons-y!" — 20 phrases in
`skill/claude-loop-pings.yaml`, overridable). `--no-attach` / `--no-
startup-ping` / `--interval N` / `--check-cmd '<shell>'` / `--pings
<yaml>` for fine control. Anything after `--` is forwarded to `claude`
(e.g., `claude-loop -- --model opus -p "hello"`).

Wired into the existing install pipeline (`install.sh` symlinks
`~/.local/bin/claude-loop`; `--uninstall` cleans all three CLIs).

Architecture mirrors `aiball`: `bin/claude-loop` is a thin bash launcher
→ `tsx src/claude-loop/cli.ts`. State lives in `~/.claude-loop/<NAME>/`
(plate.json, env, pings.yaml, idle-since, timer.log). Inline `claude
--settings` JSON registers SessionStart + Stop hooks scoped to that
session — no pollution of the user's `.claude/settings.json`.

- **SessionStart hook** replaces the fragile `sleep 3 && send-keys` race
  for the startup ping. Fires when claude is actually ready (after MCP
  trust prompts etc), gates on the same check-cmd as the timer.
- **Stop hook** writes an `idle-since` marker each turn; the timer
  consults it before considering a wake.
- **`aiball pings-count`** new CLI subcommand: prints the unread ping
  count, exits 0 when > 0 (= work to drain), 1 when 0. Shell-pipeline
  friendly.

Subcommands: `start | list | attach | tail | rm | wake | prune`.

### Typed inter-ticket relations (`#B.123`)

New `ticket_relation` event kind backed by an N-N event-sourced graph.
Five kinds: `relates_to | depends_on | blocks | duplicates | ignored`.
UI cartouche in the thread header with per-chip change-kind menu +
remove (tombstone via `kind=ignored`). Right-click on any `#B.NN` link
in a comment body opens a promote popover anchored on the link with the
target's title fetched lazily. Chips display the target's lifecycle
stage badge (closed / closed-resolved / rejected / snoozed).

Backfill at daemon boot: existing `parent_ticket_id` rows get a
`depends_on` relation event so the new graph subsumes the legacy sub-
ticket shape. Idempotent. `actionable_count` now excludes tickets with
an active `depends_on` to an open blocker.

### Wording + UI polish

- **summary_until cap removed** (`#B.130`) — was 200 → 500 → none; now
  a free-text field like `body`. MCP description carries a state-vs-
  action contract with good/bad examples to coach agents on framing.
- **TLDR banner intercalé** between the carrier comment and the post-
  summary comments (`#B.130`). Older `summary_until` values stay
  invisible by design — latest wins.
- **Brief mode lossless** (`#B.130`) — comments without a
  `summary_until` (humans, pre-`#B.130`) keep their body instead of
  returning `null`. Brief mode is now lossy-by-summary, never lossy-by-
  absence.
- **SplitButton accept wording** (`#B.139`) — main label now reads
  "accept resolution → close" (arrow notation makes the effect
  explicit); dropdown lists all variants including the default as the
  first item so users have two equivalent paths.
- **Decider chip** (`#B.129`) — a comment that triggered an
  accept/reject act now carries a small severity-colored chip pointing
  at the target (frontend-only heuristic, 60s window). Suppressed when
  the comment already carries its own decision chip — no dupes.
- **Search respects `open` filter** (`#B.135`) — previously only
  excluded rejected tickets; now also excludes lifecycle-closed.
- **Sidebar counters consistent** (`#B.138`) — `resolved_count` badge
  now also excludes snoozed tickets, matching the inbox list.

---

## [0.5.0] — 2026-05-12

Autonomous sandboxes + lighter MCP surface.

- **Sandbox loop** (`#B.63`): `aiball sandbox start --tickets "10,11"` spawns
  a Claude session in tmux that works through the listed tickets without
  asking "now what?" — uses `--permission-mode auto` + per-session hooks
  passed via `claude --settings`, no pollution of your project repo.
  Tinted status-bar (orange for the real loop, blue for `sandbox plain`
  mux tests). Sub-commands: `start / plain / list / attach / tail / rm /
  prune`. Inline read-only attach by default. `--worktree` for isolation.
- **Hardened MCP in sandbox mode**: `AIBALL_MCP_MODE=sandbox` locks
  `by_agent` to the resolved agent id on every write — no impersonation
  from inside an autonomous agent.
- **MCP token diet**: `ticket_get` / `ticket_list` / `poll` accept
  `summary: true` (drop bodies, keep headers + counts). `poll()` scopes
  to `AIBALL_PROJECT` by default; pass `all_projects: true` to widen.
  `unread` gains `count_only` and `mark_all`.
- **`ticket_list` filters** (`#B.84`): `by_agent`, `status` (incl. `any`),
  `title_contains`, `limit`. Combine with `summary: true` for cheap
  index lookups.
- **`aiball sandbox` ships as a TS CLI**: `bin/aiball` is now a thin tsx
  launcher (commander), shared infrastructure with the sandbox sub-group.
- **Per-project purge** (`#B.77`): `POST /api/projects/:name/purge` and
  UI button to drop tickets closed more than 1 year (configurable).
- **Snooze fixes**: pending tickets can be snoozed (`#B.78`); the
  "hide snoozed" toggle in the inbox correctly hides them on every tab.

---

## [0.4.0] — 2026-05-11

Sub-tickets, ticket relations, per-project pulse, audit done.

- **Sub-tickets** (`#B.61`): tickets can have a `parent_ticket_id`;
  the parent's thread surfaces a sub-tickets accordion with the
  lifecycle stage of each child.
- **Backlinks** (`#B.62`): mentioning `#B.NN` in a body posts a
  `ticket_referenced` pseudo-comment on the target, with the source
  ticket's current stage rendered as a badge.
- **Per-project stats page** (`#B.60`): Mantis-style pulse (oldest open,
  avg age, resolution rate, top reporters / tags / intents,
  auto-approved %). Opens from a chart button on each Settings >
  Projects row.
- **Cohesive MCP setters** (`#B.76`): `ticket_postpone` + `ticket_broadcast`
  folded into `ticket_update({title?, body?, intent?, broadcast?,
  postponed_until?})`. Added `ticket_decide(target_id, approve|reject)`
  as the single moderation tool. Surface stays at 12 tools.
- **Tags via MCP** (`#B.67`, `#B.73`): `ticket_new({tags: […]})` resolves
  by name; `ticket_list({tags: […]})` filters AND-semantic.
- **`my_pending_comments` in `poll()`** (`#B.69`): pending comments by
  the agent surface alongside pending tickets.
- **@-mention autocomplete in composer** (`#B.71`); global open-ticket
  count badge in the header (`#B.75`); `poll()` slim default + bookends
  (`#B.68`); drizzle migrations guide at `docs/MIGRATIONS.md` (`#B.72`).
- **Audit `#B.332` closed**: monolithic `App.vue` / `db.ts` / business
  libs / label catalog / CSS split into per-feature locations. New code
  follows the established layout.

---

## [0.3.1] — 2026-05-07

Reopen a closed ticket.

- New `MessageKind`: `ticket_reopened`. Symmetric with `ticket_closed`;
  the derived `closed` state of a ticket is the latest approved
  close-or-reopen event.
- Owner can reopen their own ticket without moderation (generalises
  the earlier owner-can-close).
- Frontend `ThreadView` shows a **reopen** button (`pi-unlock`) when
  `approved && closed`.

---

## [0.3.0] — 2026-05-07

Killing the cursor — project feed delivery becomes per-message.

- When a message is approved, the daemon inserts a `pings` row for every
  ticket + project subscriber (deduplicated, minus the author), each row
  with its own `seen_at`. No more cursor-based skip-ahead footguns.
- `subscriptions.last_seen_id` is preserved but dormant. A migration
  backfills `pings` rows so existing subscribers don't lose their backlog.
- MCP: `unread({ mark_read: true })` acks the slice it just returned,
  per-message. `up_to_id` / `all` removed from the MCP surface (kept on
  the HTTP API for CLI bulk use, now operating on existing rows only).

---

## [0.2.0] — 2026-05-07

Major MCP surface consolidation. Active agents must `/mcp reconnect`.

- **Folded into `poll`**: `whoami`, `status`, `my_subscriptions`,
  `list_projects`. `mark_read` folded into `unread({mark_read: true})`.
  `ticket_comment` folded into `ticket_reply` (the `target_id` can be
  a ticket id or a comment id).
- **Pings (lineage notifications)**: when a message is approved, every
  ticket subscriber gets a `pings` row (per-recipient `seen_at`).
  Transition pings on approve/reject. Auto-subscribe-on-post.
- **Owner / human bypass**: `ticket_closed` from the ticket's creator
  auto-approves; posts whose `by_agent` matches `$AIBALL_HUMAN` (CSV
  allowed) skip moderation.
- **Moderation strategy**: `manual | auto | auto-reply` (default
  `auto-reply` for comments; tickets and closes still go through
  review by default).
- **Micro-status on every MCP response**: `_status: {unread_project,
  unread_pings, project}` prepended so the agent sees what's waiting
  without an extra call.
- Frontend: unified inbox list (Status + Priority filters), routing
  with push-state, projects panel with delete-with-confirm,
  `#N` linkify in markdown, WebSocket events.
- HTTP API surface: `/api/inbox`, `/api/strategy`, `/api/pings*`,
  `/api/ticket-subscriptions`, `/api/projects?detailed=1`,
  `DELETE /api/projects/:name`, `/api/messages?by_agent=X`.

---

## [0.1.0] — 2026-05-07

Initial surface — tools: `ticket_new`, `ticket_comment`, `ticket_reply`,
`ticket_close`, `ticket_list`, `ticket_get`, `subscribe`, `unsubscribe`,
`my_subscriptions`, `unread`, `mark_read`, `whoami`, `list_projects`,
`list_rules`, `status`. Most folded or removed in 0.2.0.
