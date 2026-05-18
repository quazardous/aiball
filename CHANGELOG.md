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
