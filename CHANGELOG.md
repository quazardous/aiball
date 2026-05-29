# Changelog

Notable changes to aiball — the MCP surface, HTTP API, UI, and CLI.

**Style**: human-friendly, synthetic. Each entry is a short paragraph or a
handful of bullets describing what changed for users / integrators, not a
file-by-file diff. Dates are YYYY-MM-DD; format inspired by Keep a
Changelog.

**Versioning**: the source of truth is the repo-root `package.json` (the
`aiball` component in `qcmp.yaml`). The running version is surfaced via
`aiball --version`, `GET /api/health`, and the web UI footer. Frontend and
other components track their own versions; this file is the human-readable
narrative for the product as a whole.

---

## [Unreleased]

*Nothing yet.*

## [0.9.4] — 2026-05-29

### `bin/fake-claude` reborn over `textual` (#605)

The first cut of the simulator mixed `rich.live.Live(Panel)` for the
streaming output with manual ANSI cursor positioning for the prompt
zone. Live's 10-FPS repaint trampled the cursor, and the input that
followed inherited a parasitized position. Switched to `textual` —
the TUI framework by the same authors as rich — where each region is
a real widget that owns its area:

```
┌────────────────────────────────┐
│ Static  : flash header         │   ← `✻ Working…`
├────────────────────────────────┤
│ RichLog : echoes + stream      │   ← scrollable output
├────────────────────────────────┤
│ Input   : `❯` composer         │   ← cursor lives here, native
├────────────────────────────────┤
│ Static  : `⏵⏵ auto mode on`    │   ← state footer
└────────────────────────────────┘
```

Screens become typed (`header_flash` / `picker` / `prompt` / `stream`
/ `write`) and the play loop dispatches on kind. The streamer and the
user input run truly in parallel via textual's async event loop, so
the lorem flux can keep pushing lines into `RichLog` while the
composer stays alive in `Input`. Markers (`esc to interrupt`,
`Resume session` + `Space to preview`, `auto mode on`, …) preserved
verbatim — claude-loop's pane probe doesn't care how the bytes were
rendered, only that they're on screen.

`Ctrl+D ×2` quits bash-style (first press shows a 2-second window
hint in the header); `Ctrl+Q` quits directly. PEP-723 inline deps
bumped to `textual>=0.50` + `pyyaml>=6`. Pipe mode disappeared (the
TUI refuses to render outside a TTY, by design); use
`App.run_test()` from a Python harness for non-interactive smoke.

### Mobile borders edge-to-edge (#609)

On smartphone viewports (`max-width: 720px`), the inbox list, the
thread comments, and the reply composer all sat inside a 0.5 rem
horizontal padding with full per-comment borders, doubling the
visible separation. Two passes :

- Drop the horizontal padding off `.aiball-main` and the
  left/right/radius off `.comment-card` and `.composer` — content
  reaches the screen edge, internal padding keeps text aerated.
- Drop `.comment-card` border-top too so two adjacent comments
  separate with a single 1 px line, not the `bottom + top` doubling
  that the first pass left in place.

Inbox list-rows already had only a `border-bottom`, so the first
change was enough there. Desktop layout untouched (all gated by
`@media (max-width: 720px)`).

### Mobile sort chooser, shared in DataList (#610)

Admin lists (Projects, Consumers, …) hide `<thead>` on smartphone and
reflow the table into card-style rows. Two consequences fixed :

- **Anonymous cells**: with thead gone, the user saw raw values
  (`3   12   2 minutes ago`) without knowing which column they belong
  to. `DataList` now stamps `:data-label="col.label"` on every `<td>`,
  and `ProjectsPanel` mobile CSS prefixes each cell with its column
  label via `::before { content: attr(data-label) ": " }`. Result:
  `Owners: 3`  `Followers: 12`  `Last activity: 2 minutes ago`
  inline in muted gray.
- **No way to pick a sort axis**: thead clicks are the only sort
  handle, and thead is hidden. `DataList` now renders a
  `.datalist-mobile-sort` strip above the table (label + native
  `<select>` of `sortable: true` columns + asc/desc toggle button)
  visible only on `max-width: 720px`. Wired to the same internal
  `sortKey`/`sortDir` the thead clicks drive on desktop, so the two
  surfaces are one source of truth. Consumer panels get the chooser
  for free as long as at least one column declares `sortable: true`.

Also flatten the ProjectsPanel mobile cards into plain rows (drop
border-radius / per-card background / margin, keep only
`border-bottom` + internal padding). Looks like a list, not a stack
of floating cards.

### Goto-ticket input slimmer (#608)

Two small UX tweaks: the header's goto-ticket input dropped its
"or hashid" suffix from the placeholder (`#N` is enough — the tooltip
still documents the full grammar) and shrank back from 6.5 rem to
4.5 rem (its pre-#570 width). A typed hashid still fits via
horizontal scroll inside the input.

## [0.9.3] — 2026-05-29

### `claude.always_resume` is now on by default (#577)

`claude-loop` (no flags) now spawns `claude` with `--resume`, so the
most recent session in the cwd is picked up automatically. Opt-out
per-tree via `.aiball.yaml` `claude.always_resume: false`, or
per-invocation via an explicit `--no-resume`. An explicit `--resume`
or `--resume=<id>` always wins regardless.

### Your own reply is read at birth (#606)

When you post a comment on a thread, the row sometimes fell back to
unread because the auto-mark-read dwell had already snapshotted an
`up_to_id` that predated your new comment. The composer now fires
`markTicketRead(ticketId, newCommentId)` straight after a successful
reply — cogito ergo scriptum, no more "my own message is unread until
I revisit". Mark-read remains best-effort; a failure only warns.

### Mark-read flicker now only fires on actually-unread threads (#596 follow-up)

The "marking-as-read" envelope chip used to pulse on every thread
visit because the `TicketSummary` didn't carry the per-consumer
unread flag (only the inbox row did). The thread payload now ships
that flag, and the `useAutoMarkRead` composable gates the flicker on
it — re-visiting an already-read ticket leaves the chip statically
gray. Also moved the chip off the H2 title into the subline so it's
always visible (gray = read, green→gray flicker = transition).

### `claude-loop init` gains `--agent` + actually writes the consumer to `.aiball.yaml` (#603)

Two fixes on one ticket:

- `--agent <id>` is now a documented alias for `--consumer <id>` on
  `claude-loop init` (the `start` command already accepted both via
  #420). Same alias added to top-level `aiball init` for parity.
- `claude-loop init --consumer foo` (or `--agent foo`) now actually
  seeds `consumer.agent: foo` into `.aiball.yaml`. Before, the
  identity was forwarded only to the remote persistence
  (`.aiball.local.yaml`) and silently dropped for the local consumer
  block — so `aiball check` post-init reported the default identity
  instead of what was just passed. If `.aiball.yaml` already exists,
  the block is patched in place via the yaml Document API
  (comments + unrelated keys preserved).

`claude-loop start --init` forwards the same fields, so all three
init surfaces share one UX.

### F9 (or your `afk_key`) now toggles the bar visibly + always-on AFK log (#601)

After the rename pass that fixed F9 firing the AFK detector, the bar
still didn't bounce between `wait` (yellow) and `loop` (green) — it
went `loop → wait → wait → wait`, because the F9 OFF marker armed a
60-second user-grace window that the `_rest_word` resolver
short-circuits on before checking AFK. F9 OFF now clears user-grace
instead of touching it: the toggle is a clean `loop ↔ wait` cycle.
The first text keystroke after F9 OFF naturally re-arms the
user-grace via the existing typing-keystroke handler, so the
"presence" semantics for real typing are unchanged.

Also: the PTY proxy now writes an always-on log at
`<state_dir>/afk.log` — one BOOT line with the configured combos
(hex) + window/esc_takeover settings, then one line per AFK-detector
feed with raw bytes, length, match/fire status, and a reason
(`combo-match`, `debounce-residual`, `no-combo-match`,
`no-combos-configured`). Lets you diagnose 3 cases without
instrumenting: (a) AFK key intercepted by your WM/tmux before
reaching the proxy → empty log, (b) AFK key reaches proxy but
emits a non-standard byte sequence → `no-combo-match`, (c) AFK key
fires correctly but the bar/state behaviour is off downstream.

### `bin/fake-claude` — scriptable `claude` simulator (#605)

New dev/test tool: a Python script that plays a YAML scenario on
stdout/stdin, mimicking the parts of `claude` that `claude-loop`,
its hooks, and the PTY proxy probe — boot splash, resume picker
(`Resume session` + `Space to preview` verbatim), `* Resuming
conversation…`, busy footer (`esc to interrupt`), `✶ Compacting`
transition, idle composer, multi-choice question. Built-in screens
match the regex markers claude-loop already relies on (no rewrites
on the consumer side).

The script uses a `uv run --script` shebang with PEP-723 inline
dependencies (`rich`, `pyyaml`) — zero manual `pip install`, single
file, deps resolved into a cached venv on first run. Renders via
`rich`: rounded `Panel` for the composer (cursor positioned inside
the box), `Group` for the resume picker, busy header above a
`Live(Panel)` cyan that fills line by line for the streaming output
(salvo style, configurable random 1–3 s between lines).

5 example scenarios ship in `examples/fake-claude/scenarios/`:
`default` (REPL — boot + loop on the idle composer), `picker-resume`,
`quick-prompt`, `boot-stuck`, `busy-immediate`, `compacting`. Calling
`fake-claude` with no argument loads the default scenario relative to
the binary.

`docs/FAKE-CLAUDE.md` documents the built-in screens, scenario shape,
step / screen kinds, and the shipped examples. Requires `uv` in
`PATH` (one-line install at `https://astral.sh/uv`).

## [0.9.2] — 2026-05-29

### Visual cue for the read-transition dwell (#596)

When you open an unread ticket, a small envelope icon (same one the
inbox uses to mark unread) appears next to the title and flickers
green → muted gray over the 2-second auto-mark-read window — a "dying
lamp" animation so the moderation moment is visible instead of
silently flipping behind your back.

### Priority chip moves into the cartouche (#599)

The `urgent` / `high` / `low` priority Tag used to sit alone on its
own row above the ticket title. It's now inline with the other meta
chips (`#NN`, `project`, `intent`, `status`, lifecycle, `by <agent>`)
so the identity strip reads as one line. Hidden when priority is
`normal` (default).

### Bulk close on the inbox works for any moderator (#595)

The "close N selected tickets" button no longer fails for tickets the
moderator didn't open. The API route now resolves the caller from the
auth context when the request body omits `by_agent`, so the
`assertCloseAuthority` check passes via the `isHuman` bypass. Same
pattern other routes have always used.

### `claude-loop` rename: `cl-<project>-<hash6>` (#594, #602)

- **Naming** — the auto-generated loop name is now a deterministic
  `cl-<project>-<sha256(cwd:agent)[0:6]>`, e.g. `cl-aiball-89c365`.
  The same `(cwd, agent)` pair always resolves to the same name (no
  more "find my loop"); the tmux session name no longer doubles its
  `cl-` prefix (`cl-cl-foo` → `cl-foo-…`). Pre-rename loops keep
  their old names until you `rm` + `start` again — no migration.
- **Restart after a crash** — a `start` whose deterministic name
  matches a state-dir left behind by a dead loop now auto-cleans the
  state-dir and proceeds, instead of refusing with "already exists".
  Restoring the pre-rename behaviour where a dead loop's state didn't
  block a fresh `start`.

### `--private` flag on `init` (#593)

`aiball init --private`, `claude-loop init --private`, and
`claude-loop start --init --init-private` now seed the generated
`.aiball.yaml` with `project_type: private` so the welcome MCP serves
the private kit (relaxed conventions). Default stays public — the
welcome tool's fail-safe applies.

### `claude --resume` auto-pick + boot-phase rework (#577)

- **Boot phase** — the SessionStart hook no longer eager-injects on
  `--no-wait`. It always seeds the idle marker and exits; the timer
  drives every wake, gated on the pane probe (`esc to interrupt`
  visible = still busy / still loading). Closes the "wake hits claude
  mid-compact" class of bugs.
- **Compacting detection** — pane-state probe is footer-scoped (5
  lines) so a stale `✶ Compacting conversation…` line in scrollback
  doesn't gate wakes forever after `/compact` finishes.
- **Session-list auto-pick** — on `claude --resume` with multiple
  sessions, the hook detects the picker (`Resume session` +
  `Space to preview`) and sends Enter to take the most recent entry.
  Probes up to 15 s with 500 ms granularity (MCP-heavy boots can take
  several seconds to render the picker). Override via
  `CL_RESUME_PICK=abort`.
- **Diagnostics** — every fire is now logged to
  `~/.claude-loop/<name>/session-start-hook.log` with the resolved
  picker mode + tmux target + match timing, so a silent regex miss is
  debuggable.

### `welcome` MCP reads the caller's project (#591)

`bin/aiball-mcp` (+ Windows `.cmd`) preserve the caller's PWD in
`AIBALL_CWD` before `cd`-ing to the install root, and `welcome.ts`
walks `AIBALL_CWD ?? process.cwd()`. Without this, the MCP server's
cwd was the install dir → `welcome` resolved `project_type` from
aiball's own yaml instead of the caller's project. `claude-loop
status` now displays the resolved `project_type` so it's visible
from the CLI without invoking `welcome`.

### CHANGELOG template tells what it is (#598)

The `CHANGELOG.md` template served by the welcome MCP for new
projects now carries an explicit "this is a curated, human-readable
record — not a commit log" header in the rendered file, plus
expanded `<!-- intent: … -->` guidance with good/bad examples so the
agent writing future entries doesn't fall back to commit-message
phrasing. Reported in by `runic-claude` after a welcome-driven
bootstrap surfaced overly technical entries.

## [0.9.1] — 2026-05-29

### List harmonisation : declarative columns + DRY pass (#592, #597, #589)

Admin tables (Projects / Consumers / Nodes / NodeDetail relayed-list)
now share a single declarative API on the `DataList` shell. Pass
`columns` + `getSortValue` instead of per-panel sort state + header
markup ; per-cell rendering stays in scoped `cell-<key>` slots so
panels keep their custom badges, links and tags. Row-hover, indicator
dot and right-aligned numeric columns are now CSS utilities on the
shell, so improving any of them propagates everywhere. TagsPanel stays
in slot-mode (inline-edit cells don't fit columns-mode).

### Welcome MCP reads the caller's project (#591)

`bin/aiball-mcp` (+ Windows `.cmd`) now preserve the caller's PWD in
`AIBALL_CWD` before `cd "$ROOT"` ; `welcome` resolves `project_type`
from `AIBALL_CWD ?? process.cwd()` (the same pattern as the aiball CLI
and the MCP helpers). Without this, the MCP server's cwd was the
install dir → `welcome` saw aiball's own yaml (no `project_type`)
instead of the caller's. `claude-loop status` now displays
`project_type` so it's visible from the CLI without invoking welcome.

### claude-loop boot-phase rework + auto-pick `claude --resume` (#577)

- **Boot phase** : `SessionStart` no longer eager-injects on
  `--no-wait`. The hook always seeds `idle` + exits ; the timer drives
  every wake. Boot is detected via the pane probe (`esc to interrupt`
  visible = busy / still loading), so a wake can't fire while claude is
  loading MCP servers or compacting.
- **Compacting bug** : `classifyPaneSpecial` is now footer-scoped (5
  lines) instead of whole-pane — stale `Compacting conversation…`
  strings in scrollback no longer gate wakes forever after `/compact`
  finishes.
- **Session-list picker auto-pick** : on `claude --resume` with
  multiple sessions, the hook detects `Resume session` + `Space to
  preview` and sends Enter to take the most recent entry. Override via
  `CL_RESUME_PICK=abort` to leave the pick to the human.

### Unified config schema — infrastructure (#590 phases 1-3)

`ConfigSchemaEntry` gains `sources?: ("db" | "file")[]` + `precedence?`
so an entry can declare where it can be SET (DB SQLite admin Settings,
FILE `.aiball.yaml`, or both). A new generic FILE reader walks a dotted
key (`autopoll.tone`) into the project's `.aiball.yaml` / global yaml
with mtime-cached parsing. `getConfig(key, project, cwd?)` walks the
layers project-first then global, db-first within a layer.
Backwards-compatible (default `["db"]` preserves the #449 behavior).
Phases 4-5 (mass migration of the FILE-side scalars + auto-generated
example) are gated on the final policy decisions.

### `.aiball.yaml.example` readable rewrite (#588)

Rewritten 485 → 207 lines. Real options now uncommented with their
default values ; complex examples (consumer identity, custom wake
gates, colors, upstream bindings, prompts, formatting, tags) in
commented blocks with brief explanations + pointer to
`docs/CONFIGS.md`. 100% English, no internal ticket refs.

### Consolidation pass (#578 umbrella : #582-#587)

A targeted sweep on code that grew organically with copy-paste — no
behavior change, all enforcement of existing types or extraction of
duplicated logic :

- **#582** — `MESSAGE_SCOPES` + `ERROR_CODES` constants exported from
  `domain.ts` (+ frontend mirror) ; 10 magic-string sites unified
  (throws, catches, Zod enums, local `VALID_SCOPES` array).
- **#583** — 20 `CL_*` env var names centralised in
  `src/claude-loop/env-vars.ts` ; 37 read-sites typed via
  `process.env[CL_ENV.X]` (typo-safe at compile time).
- **#584** — `LOOP_STATUS` const (`"boot" | "idle" | "busy"`) +
  `satisfies` constraint ; 21 `setTmuxStatus(name, "raw")` call sites
  unified across 6 files.
- **#585** — `humanPresent(sd, graceSec)` composite helper collapses
  the `userIsTakingOver || humanIsTyping` OR pattern at 3 hooks
  (timer, stop-hook, pretooluse-hook).
- **#586** — close-time cleanup extracted to `src/close-cleanup.ts` :
  `autoApproveStaleDecisionsOnClose` + `rejectStaleClosedReopenedForTicket`
  ; ~60 lines of nested logic in `submitMessage` become 5 lines + 2
  named helpers + 3 focused tests.
- **#587** — comments discipline pass : ~10 verbose blocks trimmed
  (~54 lines), stale `david: "..."` verbatim quotes dropped where the
  code is self-explanatory ; WHY > WHAT.

### Lifecycle hardening : pending-ticket guards (#568, #569, #575)

- **#568** — closing a ticket no longer collides with `tickets.id ==
  messages.id` ids : `submitMessage` gates the close branch on the
  immutable `input.kind` instead of the corrupted `msg.kind` (which
  flipped to `"ticket_created"` under id collision).
  `updateMessageStatus` extended with an optional `kind` discriminator
  so callers route to the right table.
- **#569** — `ticket_reply then:"resolved"` / `then:"plan"` on a
  pending parent ticket now rejects with HTTP 409
  (`PARENT_PENDING_MODERATION`). `ticket_get` brief response carries a
  `decision_proposable` flag so the agent knows when it's safe to
  propose.
- **#575** — `POST /tickets/:id/assign` claim path + the auto-claim in
  `submitMessage` both reject with HTTP 409 when the parent ticket is
  still pending moderation. Closes a back-door where a rule-engine
  whitelist on a pending ticket could trigger an auto-claim.

### Goto-ticket smart input (#570, #571)

- The header search box now accepts comment hashids (`#egrqmh` or
  `#cegrqmh`) and navigates to the parent ticket scrolled to the
  comment.
- Git commit SHAs (7-40 hex chars, with or without `#`) get a clear
  "this looks like a git commit SHA, not a ticket id" message instead
  of failing silently.

### no_claim consumer UX cleanup — silent autopoll, no broadcast spam, gated CTA (#516)

Three-part follow-up to the per-consumer no_claim flag from earlier this
cycle. Before: a no_claim consumer (assignment-only specialist) still
received the same wake CTA as a regular agent — "engage # first" with an
empty id (because there's no claimable head to name), plus the heartbeat
fired every cycle on the bare presence of project-actionable tickets, and
they got pinged on every broadcast project event.

- **Wake CTA gated on a real claimable head.** The `engage` directive in
  the wake banner now drops when `head_id` is empty (no claimable ticket
  to point at), so a no_claim consumer no longer sees the "engage # first"
  prompt with a blank id.
- **Heartbeat silent for no_claim with no pings.** The timer's heartbeat
  wake path checks `AIBALL_NO_CLAIM=1` + `pingsCount === 0` and skips —
  a no_claim consumer with no direct pings stays idle instead of waking
  on every project landscape change.
- **Broadcast follower fan-out filtered.** New per-consumer
  `notify_project_broadcasts` tri-state column (`auto` / explicit on /
  explicit off) gates the `scope: broadcast` follower fan-out in
  `fanOutPings`. `auto` (default, NULL) follows `can_claim`: a claim-able
  consumer keeps receiving broadcasts as before, a no_claim consumer is
  silenced. Operators can override per consumer in the ConsumerEditPage
  (new "project broadcasts" select).

Migration `0044_consumers_notify_project_broadcasts.sql` adds the column
nullable (no backfill needed — NULL = auto).

### Proxy node WS reverse health on detail page (#510)

The proxy-node detail page (`/nodes/<id>`) now shows a dedicated **ws reverse**
status pill next to the existing activity pill — green `connected` /
yellow `silent` (OPEN but no frame in 30s+) / grey `disconnected`. Backed by
the live `/ws/proxy-node` map, distinct from `last_used_at` (which mixes
HTTP and WS activity). `GET /api/nodes` gains an optional `ws_state` block
(`{connected, last_frame_at, silent_for_sec}`) ; older clients ignore it.

### Automation triggers : state-change events (#509)

Three new triggers fire when an **existing ticket's structural attributes
mutate** :

- `ticket_priority_changed` — when a ticket's `priority` is edited
  (`POST /api/messages/:id/edit` or any `set_priority` automation action).
  Carries the new + old values.
- `ticket_project_changed` — when a ticket is moved across projects
  (`POST /api/tickets/:id/move`). Carries the new project + source.
- `ticket_status_changed` — when a moderator approves or rejects a pending
  ticket (`POST /api/messages/:id/approve|reject`). Carries the new status
  (`approved` / `rejected`) + the previous (`pending`).

Paired with a new `status` condition leaf — `pending` / `approved` /
`rejected` — selectable in the rule editor's field picker. Only meaningful
under the `ticket_status_changed` trigger ; on other triggers the field is
absent so the leaf fails closed.

Rules can compose old → new transitions via stacked leaves (e.g. trigger
`ticket_priority_changed` + `priority in [urgent, high]` → assign team
lead). The automation runtime itself can cascade : the `set_priority`
action emits `priority_changed` lifecycle, so a downstream rule on
`ticket_priority_changed` runs.

### Consumer no-claim flag — assignment-only specialists (#508)

A consumer can now be marked **no-claim**: `ticket_engage` skips the global
claimable pool and only surfaces tickets explicitly assigned to that consumer
via `ticket_assign`. Receiving a push, commenting, resolving and closing still
work — only the auto-claim is gated.

Two configuration paths, OR'd together:

- **Admin UI on the upstream daemon** (`ConsumerEditPage`): new "can claim"
  checkbox. Off = the consumer is assignment-only globally.
- **Project-scope `.aiball.yaml` on the agent's machine** — same level as
  `consumer.agent`:

  ```yaml
  consumer:
    agent: aiball-windows
    no_claim: true
  ```

  claude-loop reads it at boot and exports `AIBALL_NO_CLAIM=1` to the claude
  process + every child hook. The `AiballClient` injects
  `x-aiball-no-claim: 1` on each API call; the upstream's `bearerAuth`
  recognises it for any token kind (UDS, node, agent) and applies the no-claim
  semantic for that request. Lets the policy live with the agent's project,
  not the central admin UI — particularly useful for an agent whose project
  lives on a Windows machine talking through a proxy node.

Either gate suffices (OR): DB flag OR yaml/header hint → assignment-only.
Migration `0043_consumers_can_claim.sql` adds the column (default 1 = claim
allowed, existing rows preserved).

### docs/INSTALL.md — Linux/macOS install reference (#487)

- New reader-facing doc that mirrors `docs/WIN-INSTALL.md` for the Linux /
  macOS install path. Until now, the only narrative source for the install
  modes was the header comment of `install.sh` — reachable only by reading
  the script.
- Covers the **three modes** (portable / hard / `--symlink` dev), all install
  flags (`--port`, `--host`, `--no-systemd`, `--stop-hook`, `--proxy-url`,
  `--auth-init`, `--uninstall`, `--remove-stop-hook`), the daemon lifecycle
  (start / stop / `aiball restart` hard / `aiball reload` soft), the post-install
  filesystem layout, the env vars (`AIBALL_HOME` / `AIBALL_SOCK` / `AIBALL_CWD`
  / `AIBALL_PROJECT` / `AIBALL_TOKEN` / `AIBALL_URL` / `AIBALL_HOST` /
  `AIBALL_PORT`), sanity-checks, and a troubleshooting section.
- Linked from `README.md` (under the quickstart) and from the `CLAUDE.md`
  docs index.

### Proxy node detail page (#452)

- Each **proxy node** (Settings → Proxy nodes) now has its own **detail page** —
  click a node's name to open it. The **relayed consumers** (the clients a node
  forwards to this daemon) moved off the node-list row, which was getting wide,
  onto this page, next to the node's id, last peer IP and created/last-activity
  times. Revoke lives there too.

### Send a raw prompt to a claude-loop (#451)

- A **consumer's page** (Settings → Consumers → a consumer) gains a **"send a
  raw prompt"** box: type a prompt and it's injected **verbatim** into that
  loop's Claude session — no moderation, no wake-phrase indirection — for a
  direct operator instruction.
- **Spooled then delivered**: the prompt is queued in a volatile in-memory spool
  (no DB/file), then if the loop is live it's drained onto its SSE now
  (`control:prompt` → the loop injects it like a wake, PTY proxy / tmux); if the
  loop is offline it waits in the spool and is drained when the loop's SSE
  reconnects. Volatile by design — a daemon restart clears it (fine for now).
- **Privileged**: same gate as remote stop (#442) — moderator-only, proxy-node
  tokens denied (an arbitrary prompt can hijack an agent).

### Pending tickets stay out of the backlog (#450)

- A not-yet-approved ticket still pings participants (so it can be discussed)
  but no longer shows in the open backlog list — it appears only under the
  explicit **Pending** (moderation) view. Tickets that are approved but carry
  pending comments are unaffected. (Counters already excluded pending.)

### Unified config manager (#449)

- New schema-driven config framework: a key's metadata (scope, type, default,
  protected) is declared in code (`src/config/schema.ts`), overrides live in a
  generic `config_overrides` table, and a layered read resolves **project
  override → global override → schema default**. One mechanism instead of a
  bespoke panel + endpoint + precedence per setting. REST: `/api/managed-config`
  (read resolved values; set/clear overrides; protected keys are moderator-only).
- **Generic settings UI**: one `ManagedConfig` component renders the schema in
  both **Settings → General** (global layer) and **Project Settings** (project
  layer, with the familiar "Use global (currently: X)" semantics). Add a key to
  the schema and it appears in both — no per-key panel. Protected keys show a
  lock (writes are moderator-only).
- First consumer wired end-to-end: **`tickets.default_priority`** — a new
  ticket with no explicit priority now takes the per-project (or global) default
  instead of a hardcoded `normal`. Existing settings (strategy, upload cap, tags)
  keep their own storage for now and migrate onto this incrementally.

### Claims are visible in the lists, and update live (#429, #448)

- The inbox **list rows** now show who currently holds a ticket — a discreet
  role-specific glyph (bookmark = an agent's self-**claim**, person-plus = a
  human-pushed **assignment**) with the holder's name in the tooltip. Until now
  this only showed in the thread header; the lists were mute.
- **Claims now refresh the UI in real time.** Claiming, assigning, or releasing a
  ticket previously updated the database silently — an open inbox or thread kept
  showing the pre-claim state until a manual reload. These actions now broadcast,
  so the holder icon appears/clears on the spot (lists + thread header), including
  the claims auto-released by the one-focus rule. Agent `engage`/`assign` go
  through the same path, so an agent picking up work lights up its row live.

### Per-agent work filters (#447)

- New **Settings > Work filters**: narrow which tickets an **agent** picks up, by
  tag — e.g. *the windows agent only works tickets tagged `win`*. A filter is
  `consumer + (optional project) + mode (work-only / never-work) + tags
  (any-of)`, with an enable/mute toggle. It restricts that agent's
  **engage / actionable** pool only — never your own view of the board.
- Filters live in the **daemon DB**, not in per-machine config: an agent's loop
  on *any* machine that talks to this daemon picks them up, so the same agent run
  from a second machine obeys the same filter with nothing to sync. Applied
  server-side in the actionable/claimable gate; fail-open (a read error never
  hides an agent's work). New `/api/work-filters` CRUD.

### Token tally reads as effort, not re-read context (#446)

- The per-ticket/per-project token figure is now the **effort** = new tokens
  (input + cache-write + output). Cache *reads* — the same conversation context
  re-read from cache on every turn — are no longer folded into the headline
  (they were summed per turn, re-counting the same context and inflating the
  number). The cost-equivalent (effort + cache-reads ×0.1) and the re-read
  context size are still shown, in the tooltip / stats sub-label.
- Token effort is now **drained per MCP tool call** that attaches to a project,
  not only at the end-of-turn hook — so a turn that works several tickets splits
  its effort across them (attributed to each call's ticket) instead of lumping
  to the last one. Each turn is still counted once (shared dedup, race-safe).

### `claude-loop status` (#444)

- New **`claude-loop status [name]`** — a read-only, project-level snapshot: the
  resolved project + default agent (and where each came from), the loaded
  `.aiball.yaml`, the **connection type** the client would use right now (local
  Unix socket vs remote HTTP, token or not, loopback flagged as local) with its
  endpoint, a live daemon-reachability probe (+ the daemon's version), and the
  loop registered for the current cwd. Answers "who am I and how do I reach the
  daemon", complementing `check` ("what would the timer do").

### Harmonised launch/stop buttons on the project page (#443)

- On the per-project detail page, the **launch** and **stop** controls now share a
  look — both are icon-only buttons (green play / red stop) with tooltips, instead
  of a filled text button next to an icon one.

### Notifications control moved into Settings > General (#445)

- The **“enable alerts”** button (and the mute toggle) left the header for the
  global **Settings > General** page, alongside the moderation strategy — same
  per-device behaviour, just a calmer header. Mirrors the earlier strategy-picker
  move.

## [0.9.0] — 2026-05-25

### Stop a claude-loop, locally or remotely (#442)

- New **`claude-loop stop [name]`** + a **`SIGTERM`** handler on the timer — a clean
  shutdown that kills Claude/tmux and exits but **keeps the state dir** (the loop
  shows as dead, still `restart`/`prune`-able; `rm` remains the halt + delete).
  This completes the signal convention: `HUP` = restart, `USR2` = reload,
  **`TERM` = stop**.
- The same loop can be **stopped remotely** — no shell on its host. The Consumers
  page shows a **stop button** on every live loop (behind a **confirm dialog** so a
  stray click never kills a loop); it calls `POST /api/consumers/:id/loop-stop`,
  which pushes a `control` event down the live SSE the loop already holds, and the
  timer funnels it into the *same* clean-shutdown path. The running badge clears on
  its own via the presence broadcast. Works over the tailnet since it rides the
  daemon.
- **Privileged + guarded**: loop-stop is moderator-only and explicitly **denied to
  proxy-node tokens** (a node may relay any identity, so the tier check is
  independent of the human check — a compromised node can't DoS your loops).
- First cut is **hard stop**; a graceful "pause autonomy, keep Claude alive" is a
  planned follow-up. (Already-running loops pick up the new handler after a
  `claude-loop reload`/restart, since the detached timer doesn't hot-reload.)
- **Live-status fixes (#443)**: the Consumers panel and the per-project detail view
  now read a loop's running state from live **presence** (the SSE the loop holds) —
  not just the 120 s heartbeat window — and refetch on the presence broadcast. So a
  stopped loop drops to *offline* within a couple of seconds instead of lingering as
  "running", on those views too (the project detail page previously never refreshed
  on its own). The stop button now appears on **any** live loop (busy / waiting /
  human-driven), not only an idle autonomous one — so a loop stuck right after a
  relaunch is still killable. The **per-project detail page** also carries the stop
  button now (next to each live loop), so a loop is killable from the project view,
  not only the Consumers list.

### Syntax highlighting in rendered markdown (#440)

- Fenced code blocks with a language tag (```` ```json ````, `ts`, `bash`, …) are
  now **syntax-highlighted** in rendered bodies (tickets, comments). Powered by
  highlight.js (core + a curated language set — json, js/ts, bash/shell, python,
  yaml, xml/html, css, sql, diff, ini, markdown), wired into the `marked` code
  renderer. An unknown or absent language falls back to plain, escaped text. The
  token theme is hand-written and follows the light / dark toggle.

### Focus/claim follow-ups: one-focus on engage + claim-anchored token attribution (#439)

- **One focus at a time.** Self-claiming a ticket (`ticket_engage` or a self
  `ticket_assign`) now auto-releases your OTHER **live** claims you never
  commented on since grabbing them — bare pickups, zero work lost. Claims you've
  actually worked (a comment after you claimed) survive, and the ticket you're
  engaging is never dropped (re-engage stays idempotent). Stops an agent from
  stacking claims that each drop a ticket from every other agent's pool. The
  assign response now lists `released_claims` (relayed by engage).
- **Token attribution anchors on the held claim.** A turn's token-usage is now
  attributed server-side to your most-recently-claimed **live** claim (the
  durable focus), falling back to the volatile `active-ticket` marker only when
  you hold no live claim. An incidental ticket-scoped write mid-turn no longer
  mis-attributes the turn's tokens. No migration (reuses `claimant`/`claimed_at`).

### Global moderation strategy moves to Settings → General (#438)

- The daemon-wide moderation-strategy picker left the header dropdown for a new
  dedicated **Settings → General** page (a `general` settings panel, routed at
  `/general`). The header is now purely status + actions; the global default
  (the fallback every project on *"Use global"* inherits) lives in one obvious
  settings home, with room to grow (upload caps, etc.).
- The per-project settings hint now points to *Settings → General* instead of
  the header for changing the global. UI-only — backend, API, and the
  per-project override are unchanged.

### Claim ≠ assignment — two distinct holds (#436)

- **Assignment** and **claim** are now separate concepts (fused in #418's single
  `assignee`+`is_claim`). **Assignment** (`assignee`/`assigned_by`/`assigned_at`)
  is a *responsibility* a human moderator pushes onto a consumer — **persistent**,
  no auto-expiry. **Claim** (`claimant`/`claimed_at`) is an agent's *focus* ("I'm
  on this now"), self-declared via `ticket_engage` / a self `ticket_assign` —
  **transient** (the `assign_window_sec` live window). A ticket can be **both**
  assigned to A and claimed by A at once.
- Anti-collision (`actionable` gate) now drops a ticket from your pool when it's
  **held by someone else** — a *live claim* by another agent OR an *assignment*
  to another consumer. `ticket_engage` creates a **claim**; the work-order sorts
  your live claim first, then a ticket *assigned to you*, then hot, then oldest.
  Auto-claim (commenting) sets a claim; closing releases both holds. The thread
  header shows claim and assignment distinctly.
- `ticket_get` no longer moves the token-attribution focus — only writes do, so an
  incidental read for context mid-turn doesn't steal the turn's tokens (#434).
- Migration `0036` adds `claimant`/`claimed_at` and back-fills existing
  self-claims into them. Follow-up (tracked): engage one-focus (auto-release the
  prior uncommitted claim) + fully claim-anchored token attribution.

### aiball hooks are loop-only by default (#431)

- Plain `claude` (outside claude-loop) now runs with **no aiball hooks**. The
  claude-loop hooks were already injected per-session (`claude --settings`), so
  the only global hook that fired on a direct session was the *interactive
  autopoll Stop hook* — which is opt-in (`install.sh --stop-hook`) and now
  **removable on its own** via **`install.sh --remove-stop-hook`** (surgical:
  drops only the aiball Stop hook, keeps every other hook, backs up; cleans both
  global `~/.claude` and project `./.claude`). Windows never wired it, and the
  per-session `--settings` injection is cross-platform — so loop sessions stay
  fully hooked while direct sessions are untouched everywhere.
- Docs (`CLAUDE-LOOP.md`) now spell out the unattended permission model: the loop
  runs `claude --permission-mode auto` (classifier-checked, no prompts) and its
  per-session `--settings` carries hooks only — aiball never sets/reads any global
  permission-bypass key, so a stray `skipAutoPermissionPrompt` in `~/.claude` is
  not aiball's and is not needed.

### Work-order tiebreak follows your claim (#430)

- The ticket work-order (`ticket_list`, the `ticket_engage` head, the wake-CTA
  head) now sorts a ticket you hold a **live claim** on first — within its tier
  and priority, **above** the hot-zone. The claim is the explicit focus signal
  and survives a quiet stretch (thinking / reading context), where the hot-zone
  (recent activity) decays after its window and loses your place. The 🔥 flag
  stays activity-based ("active now"). Self-claim only — an assignment is a
  responsibility, not a focus signal. Pure comparator extended + unit-tested; no
  migration. (First slice of the focus/claim umbrella, #436.)

### `ask` presence word — surface the AskUserQuestion window (#426)

- The tmux bar (and the consumers page) gain a 4th human-presence word **`ask`**
  (orange), between `wait` and `loop`. It marks the window where auto-wakes are
  already autonomous (past the ~60s user-grace) but an `AskUserQuestion` dialog
  is **still allowed** (within the ~600s ask-grace, and not AFK). Previously
  invisible — the bar just read `loop` while a multi-choice dialog could still
  pop, which read as "the hook didn't filter". Wired on both the TS painter
  (`humanPresenceWord`/`humanBarWord`) and the PTY proxy (`_rest_word`), reading
  `CL_ASK_GRACE_SEC`. `docs/CLAUDE-LOOP.md` now documents the two distinct grace
  windows (user-grace vs ask-grace) + the `ask` word. No migration.

### Custom wake gates (#428)

- A new `claude_loop.gates` knob (`.aiball.yaml`) attaches **gates** to the loop
  wake: checks run each heartbeat whose message is **prepended to the wake CTA**
  when they trigger — e.g. *"you have an un-merged PR, resolve it before new
  work"*. Two forms in one list: **built-in** pre-wired detectors (`type:
  unmerged_pr` — zero shell) and **custom** shell checks (`name`/`cmd`/`message`;
  exit 0 = triggered, the cmd's stdout overrides the message). `blocks: true`
  makes the wake lead with the gate and suppresses the "engage" directive
  (default is warn). Built-in wording is rendered through the prompt-template
  system (slot `gate_<type>`, per-project overridable, tone-aware, with
  detector placeholders like `{count}`). Generalises the single, message-less
  `check_cmd`; pure parser unit-tested; no migration. (A web-UI gate-status
  surface is a planned follow-up.)

### Token cost on inbox rows (#427)

- The inbox list now surfaces each ticket's **token-effort cost** — the same
  cost-equivalent figure as the thread header (input + cache-writes + output
  counted full, cache reads weighted 0.1×), rendered as a discreet amber ⚡
  chip beside the comment count. Shown only once usage has been captured for a
  ticket. The list endpoint now returns the per-ticket `token_usage` tally
  (one batched query per page). No migration.

### Work tool — `ticket_engage` (#423)

- A new MCP tool **`ticket_engage`** splits *exploration* from *engagement*:
  `ticket_list` stays read-only (browse the backlog), while `ticket_engage`
  returns the head of your actionable work-order **and claims it for you** in one
  step, then hands back the ticket (brief, ready to act on). The claim lands
  before your first comment, closing the pickup→first-comment window left by the
  auto-claim. The wake CTA now points agents at `ticket_engage()`. Builds on the
  assignment/claim from #418; no migration.
- **Fix (#432):** a bare `ticket_engage()` ignored the `AIBALL_PROJECT` default
  and ran cross-project, so the head could be a *follower-broadcast from another
  project* (an aiball agent claimed a stale qdadm migration notice). Now applies
  the default softly (explicit arg wins, set default scopes, genuinely-unset
  stays cross-project) — matching the documented "Defaults to `$AIBALL_PROJECT`
  if set".
- **Claimable vs actionable (#432):** a new, narrower lens. `actionable` stays
  inclusive — a broadcast from a project you only *follow* is still actionable /
  visible. `claimable` = `actionable` **AND** in a project you **own** (role
  `owner`): claiming commits you to the work, which belongs to that project's
  owners. `ticket_engage` now claims the head of the **claimable** set (so even
  cross-project it never grabs a followed project's broadcast), the wake CTA
  names the claimable head, and `ticket_list` gained a `claimable` filter + a
  per-row `claimable` boolean (alongside `unread`/`actionable`). Counts, the
  gate, and the sidebar are untouched. No migration (the `owner`/`follower`
  role already exists on subscriptions).

### Ticket → agent assignment + claim (#418)

- Tickets can now be **assigned** or **claimed** so several agents on one project
  don't double-work the same ticket. One model, two ways in: a human moderator
  **pushes** an assignment onto a consumer, or an agent **claims** a ticket for
  itself (`is_claim`). A *live* assignment removes the ticket from every **other**
  consumer's `actionable` pool — anti-collision — while staying open for them.
- The hold is **time-boxed**: it lapses after `assign_window_sec` (global config,
  default 4h) so an abandoned claim returns to the shared pool; expiry is derived
  from `assigned_at` (no stored deadline, same pattern as the hot window). Closing
  a ticket auto-releases its assignment.
- New MCP tools `ticket_assign` (omit `assignee` to self-claim; another id is
  moderator-only) and `ticket_release`; HTTP `POST /tickets/:id/assign` +
  `/release`; `assignee` / `assigned_at` / `is_claim` surfaced on ticket reads.
  (The thread header shows who holds the ticket as discreet muted text — #429
  replaced the early oversized pill badge with a plain `person · name` line.)
- **Auto-claim**: an agent posting a comment on a ticket nobody else actively
  holds claims it for that agent automatically — the anti-collision becomes a
  side effect of working, no explicit claim discipline to keep. Never steals a
  live claim; the window + auto-release keep it self-maintaining.

### Level logger for claude-loop (#412)

- A small PSR-3 / RFC 5424 level logger (`src/log.ts`):
  `log.debug/info/notice/warning/error/critical/alert/emergency` (+ `log.log`),
  filtered by a configured **threshold** — below it, messages are dropped before
  formatting. The claude-loop **timer**, **Stop hook** and **restart handlers**
  now route through it; the `timer.log` / `stop-hook.log` / `restart.log` formats
  are preserved (now carrying the `LEVEL` token), so `claude-loop tail` / `--log`
  keep working. Threshold from `.aiball.yaml claude_loop.log_level` →
  `CL_LOG_LEVEL` (default `info`). Roll-your-own, no dependency. Migrating the
  daemon's scattered `console.*` onto the same logger is a follow-up slice.

### Nodes panel (#424)

- A **Nodes** panel (settings sidebar + mobile footer) lists each proxy node —
  every `node` token — with its label, last activity, last peer IP, and the
  consumers it relays (grouped by IP), plus **revoke** (deletes the node token →
  the proxy can no longer relay). The node's address is stamped on its token at
  relay time (`tokens.last_seen_ip`). The token value is never exposed: a node is
  addressed by a non-secret id. `GET /api/nodes` + `DELETE /api/nodes/:id`,
  moderator-only. Builds on the remote-detection signals from #422.
- **Revoke confirmation (#433):** revoke now goes through the app's styled
  confirm dialog (not a bare native prompt) with an impact-aware message — it
  names how many relayed consumers lose access until the node is re-enrolled.

### Detect remote agents (#422)

- The daemon now records the **transport** each consumer was last seen on
  (`last_seen_via` ∈ `uds` / `tcp` / `node`, plus the peer `last_seen_ip`),
  stamped at auth on every request. A consumer is surfaced as **remote** when it
  reached the daemon from elsewhere — relayed by a proxy node, or directly over
  TCP from a non-loopback address — vs a local same-uid client over the Unix
  socket. `/api/consumers` exposes the fields + a derived `remote` flag, and the
  Consumers panel shows a "remote" / "via node" badge. Last-seen / per-connection,
  not a sticky property.

### Wake-prompt system — radically simpler (#400)

- The wake/relance prompt templating is now **one template + a tiny placeholder
  grammar**, replacing the branchy per-slot assembly (david: "le système de
  prompt devrait être simple, pas du `if` partout"). Grammar (shell-inspired):
  `{var}` (value, empty when unset), `{var:-default}`, `{var:+text}` (text only
  when the var is non-empty — the inline condition that removes the `if`s).
  Tool-call braces inside a conditional (`unread({pings: true})`) are safe.
- Calling code is just `renderSlot(map, name, vars)` — no tones, no plural
  slugs, no conditional assembly. **Variants** (tone, language, singular/plural)
  are now simply **separate named templates**; the caller picks the name.
- Dropped from the engine: the 3 slot shapes / `{tone: …}` nesting / `_one`
  `_other` plural variants / the separate `resolve` callback (callbacks are just
  values now). The wake `prompts:` block collapses from ~7 slots to
  `wake_lead` + `wake_master`. Pure refactor — no behavior change to *what* the
  wake says, only how it's built; no migration.

- A **Launchers panel** in the UI (sidebar + mobile footer) lists the
  operator-approved commands and runs one on click — so you can "launch Chrome"
  straight from aiball.
- The daemon can spawn a small set of **operator-approved commands** (e.g.
  "launch Chrome") declared in the global config `launchers:` list — never an
  arbitrary command from the API (which references a launcher only by `id`). New
  endpoints: `GET /api/launchers` (list the declared launchers) and
  `POST /api/launchers/:id/run` (**human-only**, detached spawn). The spawn
  inherits the user's graphical-session env (`WAYLAND_DISPLAY`/`DISPLAY`/
  `XDG_RUNTIME_DIR` — verified present in the systemd --user daemon), so GUI apps
  launch. Config shape:

  ```yaml
  launchers:
    - id: chrome
      label: Chrome
      cmd: google-chrome-stable
      args: ["--new-window"]
      icon: pi-google          # optional PrimeIcons class for the UI button
  ```

  Project-level (`.aiball.yaml`) launchers are the next step.

### Near-realtime claude-loop running detection (#395)

- **Loop activity tags** (q3bfvn): the project detail page now shows the running
  loop's **busy / idle / boot** activity and its **loop / human / stop / wait**
  presence as CSS tag-badges (same colour scheme as the Consumers panel) instead
  of plain "busy · loop" text — in the header next to `running` and per-loop in
  the roots list. `/api/projects?detailed` exposes `running_state` /
  `running_human` / `running_human_word` for the running loop.
- A loop's **`running` state now flips near-realtime** instead of lagging up to
  120 s. The loop already holds a long-lived SSE connection (`/api/events`); its
  connect/disconnect is now the liveness signal — connect → `running:true`,
  disconnect → (after a short grace that absorbs reconnect blips) `running:false`,
  each broadcast immediately so the UI lights up at once. **Stop detection** is
  the big win: before, a dead loop lingered "running" until its last heartbeat
  went stale; now presence is **authoritative** over the heartbeat for any loop
  seen this session, so it reads stopped within seconds. The 120 s heartbeat
  window survives only as a bridge for loops never seen via SSE this session
  (e.g. right after a daemon restart). In-memory, **zero migration**, no
  loop-client change — built on the existing SSE transport.

### Big-thread reads — paginate `ticket_get(full)` (#396)

- `ticket_get` **full mode is now paginatable**: `offset`, `limit`, and `order`
  (`asc` = top_down/oldest-first, default; `desc` = bottom_up/newest-first). So
  `full + order=desc + limit=10` returns the 10 most recent thread entries **with
  full bodies** — a bounded read on a huge thread instead of pulling the whole
  thing. The response carries a `pagination` block (offset/limit/returned/total/
  order/has_more) when paging is active. `brief` / `digest` keep their own
  shapes (params ignored).
- **Safe default for the agent path**: in the MCP tool, a bare `full:true` (no
  `limit`) now returns the **20 most recent** entries (`order:desc`) + a
  pagination block, so a reflexive full on a huge thread can't overflow the
  response cap. Override with `limit` (e.g. `limit:9999` for everything) / `offset`
  / `order`. The raw HTTP API still returns the whole thread (the web UI renders
  it all) — only the agent-facing default is bounded.

### Remote/proxy ergonomics — one-command setup + node tokens (#394)

- **`claude-loop init --aiball-url … --aiball-token … [--consumer --project]`**
  now persists a `remote:` block to `.aiball.local.yaml` (chmod 600, git-ignored)
  **and** bootstraps the project. Afterwards a plain **`claude-loop start`** (no
  flags) reconnects to the same remote; per-start flags still override.
- **`aiball proxy init --url … [--token …]`** writes the `proxy:` block to the
  global config (no hand-editing YAML). **`install.sh --proxy-url … [--proxy-token …]`**
  does the B side at install time (skips local `auth init` — a proxy node has no
  local DB).
- **Node tokens** (`aiball auth issue --node`, migration 0030 widens the
  `tokens.kind` CHECK): a trusted-proxy **service token** (no consumer) that lets
  a proxy node **assert** the relayed `x-aiball-consumer` (X-Forwarded-For model)
  — so each relayed write keeps its real loop identity on the remote, instead of
  all being attributed to the node. Not human; the delegated consumer's own
  privileges apply. Regular agent tokens still ignore the header (token wins).
- **Trust model documented** (`REMOTE.md` § Trust model & threat model): the
  forwarded identity is trusted on the node token alone (node-level proof, the
  cross-host analog of the UDS same-uid local-trust) — *not* per-consumer, so a
  node token is **impersonation-capable** and unscoped. The `auth issue --node`
  output now carries a louder security note (private network only; use #390
  direct mode for per-consumer proof).
- **Per-consumer proof *through* the proxy** (QW-A): the proxy no longer clobbers
  an `Authorization` header the caller already set — it injects the node token
  only as a **fallback** for token-less callers. A loop carrying its own
  per-consumer agent token now gets hard per-consumer proof at the remote
  end-to-end through the proxy, with the node token left to cover only genuinely
  token-less local clients — shrinking the node token's blast radius in practice.
- **Strict mode — close the weak point entirely** (`proxy.strict: true`, or
  `aiball proxy init --strict`): the proxy **never** injects the node token as a
  fallback. Every relayed request must carry its own per-consumer bearer; a
  token-less call is rejected with **401** at the proxy. The node can no longer
  *assert* an identity, so the remote authenticates every write per-consumer and
  the cross-host weak point is gone. Opt-in (default off) — turning it on means
  provisioning each local client with its own token (`auth issue --consumer`) and
  giving up token-less convenience (web UI / CLI over the UDS).
- **Node-managed token store** (`aiball proxy token add/list/revoke`): the proxy
  node can hold a `{local token → upstream A-token}` map and **swap** an incoming
  local bearer for the mapped per-consumer A-token at egress. Clients hold only a
  *local* token; the real A-token's custody + rotation/revocation stay on the
  node, while the remote still gets hard per-consumer proof. Pairs with strict
  mode to close the weak point *without* losing local convenience. Store at
  `~/.config/aiball/proxy-tokens.yaml` (chmod 600); a bearer not in the store
  passes through untouched (QW-A). Zero migration (file store, DB-less on B).
- **`docs/SECURITY.md`** — a plain-language map of aiball's trust boundaries
  (local UDS / direct / proxy-node) with diagrams, spelling out where the limits
  are: the proxy node token is the weak point (impersonation-capable, unscoped →
  private-network-only).
- **Proxy-mode landing page**: a daemon in proxy mode no longer serves the (
  degraded, no-live-`/ws`) SPA — it shows a tiny self-contained page saying
  "this daemon is a proxy" with the remote URL + a link to the real UI. `/api`
  and `/uploads` still forward for local clients.

### Local projects — running indicator + single-loop launch gate (#393)

- The projects list now shows, at a glance, **whether a claude-loop is currently
  running** for a project (not just whether its root is known): the sidebar
  desktop chip turns **green and pulses** when live, stays a dim grey when the
  root is known but stopped. `/api/projects?detailed` exposes a new `running`
  flag (a rooted consumer heartbeated within 120 s).
- The **launch button is gated** when a loop is already live at a root — the
  project detail page shows a `running` status instead of a launch button, and
  `POST /api/projects/:name/launch` rejects with **409** if a loop is already
  heartbeating at that root (no accidental duplicate).
- The sidebar `local`/`running` chip is now an **indicator only** (no link); the
  link to the project detail lives in the Projects page (Settings → Projects).
- **Exact root↔project attribution** (migration 0029, `consumers.project`): a
  claude-loop now pushes its **project** alongside its root, so a project is
  marked `local`/`running` from the loop's *own* project — not from every
  project the consumer ever posted on. (Consumers that haven't re-heartbeated
  yet fall back to the previous authored-content heuristic, self-healing on the
  next heartbeat.)

## [0.8.0] — 2026-05-23

### aiball proxy-node mode — a local daemon that relays to a remote (#394)

- A local daemon can run as a **transparent relay** to a remote aiball: add a
  `proxy: { url, token }` block to the global config (`~/.config/aiball/config.yaml`)
  and the daemon forwards `/api/*` + `/uploads/*` to the remote (injecting the
  bearer, preserving `x-aiball-consumer`), pipes the remote's SSE back, and keeps
  no local DB.
- So **every** local client on that host (claude-loop, MCP, CLI, web UI) keeps
  using localhost / the UDS token-less — no per-client remote config. Coexists
  with the direct `claude-loop --aiball-url` path (#390).
- Resilience: remote unreachable → 502 → the local client spools for replay (#389).
- See [`docs/REMOTE.md`](docs/REMOTE.md) § Proxy mode. (Cross-host launch from the
  web UI — the #393 reverse control channel — is a follow-up.)

### Local projects — detect, detail, launch from the UI (#393)

- A claude-loop now **pushes its working directory (root)** to the daemon on each
  state heartbeat (migration 0028, `consumers.cwd`). A project is **"local"** when
  a loop with a known root has worked it.
- The **projects sidebar** shows a `local` badge; `/api/projects?detailed` exposes
  `local` + `roots`.
- New **project detail page** (Settings → Projects → the screen icon): the
  project's root(s), the loops at each root with their live state, and a per-root
  **launch** button.
- New **`POST /api/projects/:name/launch`** spawns `claude-loop start --cwd <root>`
  for a known root — **human-only**, restricted to roots the project has actually
  run on (no arbitrary-path / shell injection). Proxy-aware for #394.
- New **`claude-loop start --cwd <path>`** (≡ `cd <path> && claude-loop start`) —
  the building block the launch endpoint uses.

### Tailscale is now a managed provider, not a manual command (#380)

- **`aiball init tailscale [--http] [--port N]`** writes the host-level
  `providers.tailscale` block to the global config (`~/.config/aiball/config.yaml`),
  preserving existing keys + comments. The daemon brings it up automatically at
  boot (systemd `ExecStartPost` → `aiball providers up`); `aiball providers
  up|down|status` manage it on demand.
- **`aiball status` now shows a `proxy:` line** — configured provider(s) + live
  serve status + URL (or `down`).
- The standalone **`aiball-tailscale` command is gone**: its `tailscale serve`
  logic is inlined into `src/providers.ts` (the unified provider manager), so
  there's no separate script and no user-facing per-provider command. Existing
  installs: re-run `bash install.sh && systemctl --user restart aiball` to drop
  the old symlink and pick up the autostart hook.
- Docs rewritten around the auto path: [`docs/TAILSCALE.md`](docs/TAILSCALE.md),
  README, `docs/CONFIGS.md`.

### Remote aiball — a local `claude-loop` slaved to a remote daemon (#390)

- New `claude-loop start` flags: **`--aiball-url`**, **`--aiball-token`**,
  `--consumer`, `--project`. They point a loop running on machine B at an aiball
  daemon on machine A (tailnet/LAN) — B needs no aiball install. The loop, tmux
  session and state stay local; only the data plane (tickets/comments/pings/
  uploads) is remote. The connection is persisted in the loop's plate, so
  `claude-loop restart` replays it; the env file is `0600` when it holds a token.
- New **`aiball download <ref>`** — fetch a ticket's attached upload
  (`/uploads/<sha>.<ext>`) over the authenticated transport and write it locally,
  so a remote loop can read images it can't open as `file://`.
- See [`docs/REMOTE.md`](docs/REMOTE.md) for the setup. (The daemon already
  supported per-consumer bearer tokens and TCP for every endpoint — this wires
  the loop to use them.)

### Fix: deterministic write rejections no longer vanish into the spool (#389)

- The CLI/MCP client treated the file spool as a catch-all fallback: **any**
  failed `POST /api/messages` was queued for later replay. But a deterministic
  4xx (e.g. a non-reporter trying to `close` someone else's ticket → 403) would
  only fail again identically at replay and get dumped into `spool/failed/` —
  so the call returned a misleading `queued: true` and the comment body was
  **silently lost** (9 such closes lost since 2026-05-11).
- The client now distinguishes a deterministic client error (4xx — surfaced to
  the caller immediately, so the agent sees "post `ticket_resolved` instead")
  from a transport/daemon failure (connection refused, timeout, 5xx — still
  spooled for replay).
- `aiball status` now counts and warns on `spool/failed/` (it only ever showed
  `N pending` from the spool root, so a growing graveyard of lost writes was
  invisible).

### `claude-loop restart` + SIGHUP self-restart (#388)

- New **`claude-loop restart [name]`** — a HARD restart: kills claude + the tmux
  session + the detached timer + the state dir, then relaunches the loop fresh
  with the **same start config** (replayed from the plate: name, interval,
  check-cmd, claude args, cwd). Unlike `reload` (timer-only, claude survives),
  this is a full stop+start. Detached + `--no-attach` — reconnect with
  `claude-loop attach <name>`.
- The detached timer now traps **SIGHUP**: it spawns a detached `restart` and
  exits, so `kill -HUP <timer.pid>` is a self-service hard restart. (The handler
  delegates to a detached child precisely so it survives killing its own
  session/pid.) A remote/UI trigger can hard-restart a project's loop just by
  sending SIGHUP to the timer pid — no out-of-session supervisor needed.

### Fix: an anonymous local call no longer wakes the `human` consumer (#386)

- A Unix-socket (local-trust) request **without** an `X-Aiball-Consumer` header
  resolves to the literal `"human"` consumer for authorization — but it used to
  also `touchLastSeen("human")`, so `human` kept "resurfacing" as recently-active
  on the consumers page even when the human only ever uses a named identity.
- Now `last_seen_at` is bumped **only for an explicit identity** (header present);
  an anonymous headerless call still resolves to `"human"` but no longer refreshes
  it. Named identities are unaffected. (`src/auth.ts`.)

### MCP `upload` tool — attach images via the socket (#387)

- New MCP tool **`upload({ path, name? })`**: reads a local image file
  (png / jpeg / gif / webp) and POSTs its bytes to the daemon's
  content-addressable store (`POST /api/uploads`) over the **same Unix socket**
  as every other MCP call — token-less, no TCP. Returns
  `{ url, sha256, bytes, content_type, markdown }`; the `markdown` (`![](…)`)
  drops straight into a `ticket_new` / `ticket_reply` body and renders in the UI.
- Backed by a new `AiballClient.uploadImage(bytes, contentType, name?)` raw-byte
  POST helper (UDS or TCP+token). Uploads dedupe by sha. Reading images back was
  already automatic (`ticket_get` → `attachments[]`, #283); this closes the write half.

### Drained-backlog wake reminders + set-aware dedup (#379)

New `claude_loop.drained_strategy` decides what the heartbeat does when
**only a gated backlog remains** (no pings, nothing actionable in your court, but
open tickets awaiting *your* accept/reject/reply). Default **`once`** (#379 david
krwnqu — one reminder when the pool first drains, then quiet until the landscape
moves; set `silent` to opt out). Spectrum `silent | once | stale[:PT2H] |
backoff[:PT10M[/PT1D]] | persistent[:PT30M]` (ISO-8601 durations; bare names use
defaults), evaluated by the pure `drained-strategy.ts` (unit-tested). The shared
primitive is a server-side **`landscape_hash`** (sha1 of the sorted
`<id>:<last_actor_at>` of the agent's open tickets, behind `&landscape=1` — no
extra query, no cache) that drives both the strategy **reset** and a **set-aware
dedup** of the actionable wake leg, replacing the count watermark that missed
swaps (a ticket leaving your court while another enters at constant count). Only
the timer evaluates the drained branch (sole writer, no cross-process race). See
[`docs/CLAUDE-LOOP.md`](./docs/CLAUDE-LOOP.md).

### AFK key default is now `f9`; `claude-loop debug-keys`; non-ASCII keys (#381)

The default `afk_key` changes from `alt+esc` to **`f9`**: `alt+esc` was confirmed
**swallowed by the OS/window manager (GNOME)** before the bytes ever reached the
PTY proxy (and it was byte-ambiguous with a coalesced double-ESC). A function key
has no OS/tmux/claude conflict and emits distinct bytes. New **`claude-loop
debug-keys`** (alias `--debug-keys`) reads keystrokes straight from the terminal
(no PTY/tmux/claude) and prints each one as `<hex> → <afk grammar>` with a ✓ when
it matches your `afk_key` — the direct way to check whether your WM/terminal eats
a combo before picking one. The `afk_key` grammar now also accepts **non-ASCII
literal keys** (e.g. the AZERTY `²`), encoded as their real UTF-8 bytes so they
actually match what the terminal sends; note a literal printable key is *swallowed*
when used as the AFK toggle (it won't reach claude). Avoid `alt+…` (WM/terminal
shortcuts), `ctrl+s`/`ctrl+q` (flow-control freeze), the readline editing ctrls,
and `f1`/`f10`/`f11`/`f12` (help/menu/fullscreen).

### Fix: AFK combo is a real toggle, robust to coalesced keystrokes (#381)

The `afk_key` combo (default `esc esc`) was a one-way switch: pressing it again
couldn't turn AFK back off (the combo always *set* the marker), while a single
ESC could *clear* it — so "esc esc to go away" worked once, then a stray press
flipped it. Two causes: the combo branch set instead of toggling, and the
buffered first keystroke cleared the marker prematurely (before the combo even
resolved). Both fixed — the combo now **toggles** away↔back, and a lone ESC no
longer touches AFK (it still reaches claude as an interrupt; resuming typing
still clears AFK). The detector also recognizes the combo when the terminal
delivers both keystrokes **coalesced in one read** (`esc esc` → `\x1b\x1b`),
which previously made arming non-deterministic with the PTY's batching.

A follow-up closed the last asymmetry: with two identical halves (`esc esc`,
`c1==c2`) a **stray ESC right after a successful toggle re-armed the detector**,
so a single later ESC closed a *phantom* combo and flipped AFK back ("after the
first esc esc, one press is enough"). The detector now **forgets on both
outcomes**: a short post-fire **cooldown** (one `afk_window_ms`) swallows
residual combo keystrokes — key-repeat or a surplus tap — instead of letting
them re-arm, and a buffered first half that times out without its partner is
forgotten too. A deliberate away→back still works (two close ESC separated by a
normal human pause); only same-burst residue is ignored.

### PTY-proxy diagnostic & replay tooling (#360)

The proxy's keystroke→action logic (AFK detection, first-combo buffering,
presence `stop`/`wait`/`loop`, ESC-takeover) is now isolated in a **pure
decider** decoupled from all I/O, making the detection layer testable outside
tmux. `pty-proxy.py --replay` drives it from a timed sequence and emits one
**NDJSON verdict per event** (no tmux/claude); `CL_PROXY_LOG=<file>` makes the
live proxy log the same format. `pty-proxy.test.ts` shells real sequences
through `--replay` and asserts the verdicts — the Python counterpart to
`afk-key.test.ts`, testing the real code with no mirror to drift. See the
"Diagnostic & replay" section in [`docs/PTY-PROXY.md`](docs/PTY-PROXY.md).

### Fix: the tmux bar no longer lies `wait` while the loop is pinging (#305)

When the PTY proxy owned the bar's human segment, the presence word could latch
on `wait` after the grace window expired — even as the loop was actively waking
claude (proof the gate was open). Now an injected wake is **authoritative**:
since the timer only pings outside user-grace *and* boot-grace, receiving a wake
means the loop is autonomous, so the proxy drops both wait-reasons and repaints
`loop` — no parallel presence state to diverge, no periodic re-assert needed.

### Fix: a relaunched loop no longer boots stuck in `wait`

Since the ESC-takeover work, a present human's `wait` state is reflected even
under `--no-wait` — but the presence marker was never cleared at proxy boot
(unlike the AFK marker). So a proxy respawned in the same loop (claude
crash/resume) inherited the previous session's "human took over", and the bar
booted into `wait` with auto-pings frozen even though nobody was there. The
PTY proxy now drops any stale presence marker on boot (symmetric to the AFK
cleanup); a human who's actually present re-arms it on their first keystroke.

### AskUserQuestion no longer blocked when you're present — ask-grace + AFK key

In a `claude-loop` session, the `AskUserQuestion` dialog used to be gated on
the 60s wake user-grace, so a long agent turn could outlast it and wrongly
redirect a legitimate question. It now uses a dedicated, longer
**`ask_grace_seconds`** (default 600 = 10 min) — a present-but-quiet human
still gets the dialog; only a genuine silence falls back to "ask via a ticket
comment". And a configurable **AFK combo** (`afk_key`, default `"esc esc"`)
lets you flag yourself away *immediately* — the PTY proxy watches stdin for
the combo and toggles an `afk` marker the gate honours (see the #381 entry
above for the toggle semantics). `afk_key` uses VS Code notation (`+` for modifiers,
space for a 2-combo sequence; `afk_window_ms` bounds the gap). Parser +
detector are unit-tested; see [`docs/CONFIGS.md`](docs/CONFIGS.md).

The AFK combo is now **buffered, not forwarded**: the proxy holds the first
keystroke of the combo for up to `afk_window_ms`. If the combo completes,
*nothing* reaches claude — so the default `"esc esc"` no longer leaks through
to trigger claude's own Esc-Esc rewind. If it doesn't complete, the buffered
keystroke is flushed through unchanged (a lone ESC still interrupts claude,
just deferred by ≤ the window). Net effect with the default: a successful
`esc esc` flags you away silently; keyboard rewind moves to `/rewind`.

### Manage a ticket's subscriptions + owner from the thread

A **manage** button in the thread header opens an **inline panel** (in place,
like the edit editor) for moderators:

- **Per-subscription mute** — lists the ticket's explicit subscriptions and
  mutes / unmutes each subscriber individually, plus a **mute-all / unmute-all**
  shortcut. A mute silences that subscriber's pings on the thread **even if
  they're a project owner** (the fan-out honours an explicit mute over the
  owner role).
- **Change the ticket's owner** (its reporter / `by_agent`) — transfers
  owner-bypass (close/reopen) and subscribes the new owner.

Backed by a `muted` flag on `ticket_subscriptions` (migration 0026),
`GET /api/tickets/:id/subscriptions`, and `POST /api/tickets/:id/owner`.

### claude-loop yields to a human again — ESC takeover + grace fixes

Pressing ESC in a loop pane (to interrupt claude / take over) used to be
invisible to the wrapper — it's a control byte, not a prompt submit — so
the loop would re-ping and undo your interrupt. Now:

- **ESC = takeover**: under the PTY proxy, a bare ESC arms the user-grace
  window, so the loop backs off for `user_grace_seconds` and the tmux bar
  reads `wait`. Config-gated via `.aiball.yaml claude_loop.esc_takeover`
  (default on).
- **`--no-wait` no longer ignores a present human**: it now skips only the
  boot-grace, not the user-grace. A human who types, submits, or hits ESC
  still makes the loop yield — previously `--no-wait` (the new default)
  silently disabled that.
- **The wake-gate also yields to live typing** (the `human-typing` marker),
  not only to a submitted prompt.
- The tmux bar shows `stop` / `wait` even under `--no-wait` when a human is
  actually present.

Windows ConPTY-proxy parity for ESC-takeover is a follow-up.

### `--version` on every CLI

`aiball`, `claude-loop`, `aiball-mcp`, and `aiball-tailscale` all accept
`--version` / `-v`, printing the aiball version (source of truth: the
repo-root `package.json`, the qcmp `aiball` component). The MCP server now
advertises that version too, instead of a stale hardcoded one.

### claude-loop defaults to `--no-wait`

A loop is autonomous far more often than human-driven, so `claude-loop`
now assumes no human at the terminal by default — eager boot drain, no
boot-grace deferral. Pass `--wait` to opt back into the boot-grace for a
human take-over (`--no-wait` is still accepted as the explicit form).

---

## [0.7.0] — 2026-05-22

Agent presence you can see, a version you can read.

### Version surfaced across the app

aiball now reports its own version everywhere instead of hiding it in
`package.json`:

- `aiball --version` (also `-v`) prints it from the CLI.
- `GET /api/health` returns `{ ok, ts, version }`.
- The web UI shows `aiball v<x.y.z>` in the sidebar footer.

Single source of truth is the repo-root `package.json`; it's injected into
the frontend bundle at build time so the footer needs no runtime fetch.

### claude-loop: human-presence bar + keystroke detection + AskUserQuestion gating

- The tmux status bar carries a font-tinted human-presence word —
  **`loop`** (green, autonomous), **`wait`** (yellow, auto-pings frozen
  during a grace window), **`stop`** (red, a human is typing in the pane) —
  over the idle/boot/busy state colour.
- Live keystroke detection tells a human typing apart from claude's output
  and from the loop's own wake injection, so the wrapper never `send-keys`
  a ping over a prompt you're mid-typing.
- In an autonomous loop (no human in front), Claude Code's
  `AskUserQuestion` multi-choice dialog is denied via a PreToolUse hook and
  the agent is redirected to ask on the aiball ticket thread. Interactive
  sessions (human present) keep the dialog — fail-open.

### Docs refresh — README, keystroke-detection, roadmap

- **README** rewritten lean: *what you can do* (loop / pilot like GitHub /
  gate & monitor / take over), *quickstart* — now showing the tokenized
  `/setup?t=…` first-user URL — plus Tailscale, an *under the hood*
  paragraph (hooks + tmux + PTY proxy), and a nano-roadmap. New hero image.
- **`docs/CLAUDE-LOOP.md`** now documents keystroke detection end to end:
  the user-grace gate, the live `human-typing` marker, the
  `stop`/`wait`/`loop` bar word, and the headless AskUserQuestion gate;
  file map + state-layout table brought up to date.
- **`docs/PTY-PROXY.md`** de-staled (3-state badge, shipped status,
  `detectHumanTyping` kept as a degraded fallback).
- **`ROADMAP.md`** reworked: dropped items that already shipped, consolidated
  Windows, added multiple-agents-on-one-folder (sandbox + worktree) and a
  web-terminal item, plus a Direction section.

---

## [0.6.3] — 2026-05-20

Per-event scope, notifications, and a pile of UI polish.

### Per-event `scope` tristate replaces `broadcast` + `internal`

- One unified `scope` enum on every event row (tickets + messages), three
  values:
  - **`internal`** — owners only + `@mention` recipients (`@projet`
    narrows to project **owners**, not followers). For replies that don't
    need to spam the thread audience.
  - **`default`** — ticket subscribers + project owners + `@mention`
    recipients (the standard fan-out).
  - **`broadcast`** — `default` + project followers.
- **Composer**: a tristate dropdown that remembers the last value chosen
  per ticket (localStorage), so you don't re-pick on every reply. Initial
  fallback is `default` for every mode — replies should fan out like a
  normal post.
- **MCP**: `ticket_new` + `ticket_reply` gain an optional
  `scope: "internal" | "default" | "broadcast"` parameter, default
  `default`.
- **Schema**: `tickets.broadcast` and `_messages.internal` are dropped in
  favour of `scope TEXT NOT NULL DEFAULT 'default'` on both tables.
  Backfill: `broadcast=1 → 'broadcast'`, `internal=1 → 'internal'`, else
  `'default'` (migrations `0020_message_internal.sql`,
  `0021_scope_tristate.sql`).

### MCP `ticket_reply` — `then: "plan"`

- New value `"plan"` on the `then` enum, symmetric to `"resolved"`: tags
  the comment as a *plan proposal* with `meta.decision = { kind: "plan",
  status: "pending" }`. The reporter validates the approach via
  accept/reject before the agent executes.
- Go-signal semantics: an accepted plan re-enters the ticket into
  `actionable: true` so the agent picks it back up; a pending plan gates
  actionable identically to a pending resolution.

### Unified notification service

- Fan-out, `@mention`, and decision pings move to a single notification
  service layered above the db primitives. Accepting or rejecting a
  decision on a comment now notifies the author (previously silent).

### Config home — single `GET /api/config`

- One boot-time config endpoint replaces the per-slice config routers
  (formatting, strategy, upload limit). Config writes stay on their
  targeted PATCH endpoints.

### Data-driven ticket-text linkifier

- Ref linkification in ticket text is no longer hardcoded in the UI — it
  comes from a 3-layer config chain (shipped
  `config/defaults/claude-loop-pings.yaml` → global
  `~/.config/aiball/config.yaml` → per-project `.aiball.yaml`
  `formatting:`). New `formatting[]` config block served to the frontend
  at boot.

### Post-hoc comment classification

- Reporters can promote an undecorated comment to a plan/resolution
  decision, flip its kind, or untag a pending one — via a per-comment
  "classify" menu.

### Approving a pending ticket embarks the typed comment

- Approving (or rejecting) a pending ticket from the thread view now posts
  whatever was typed in the composer as a comment, instead of silently
  dropping it.

### Consumers panel rework

- "Add consumer" form retired — the daemon auto-inserts on first sight,
  humans go through the setup screen or `aiball auth issue`.
- Default sort flipped to activity-desc (the real triage view).
- Toolbar checkbox "Hide consumers idle > 1 week" (default ON) with an
  "N shown / M total" count so the filter never silently hides a row.
- New dedicated edit page at `/consumers/<id>` (per-row pencil button) with
  a breadcrumb header; the list table is now read-only.

### Mobile polish

- Long-press a row (~500 ms) on phones to start a bulk selection; the bulk
  bar surfaces only when a selection is active. The legacy "peek" mode is
  removed and the identity picker slimmed to current-consumer + logout.
- "← Back to inbox" link above every settings panel; auto-approve projects
  no longer fire two toasts per event.
- Mobile inbox stays fresh after a phone sleep: a `visibilitychange`
  listener tears down a zombie WebSocket and reconnects immediately;
  server-side WS pings every 25s keep middleboxes from killing idle TCP.

### claude-loop + autopoll

- Default wake-CTA phrases move to `config/defaults/claude-loop-pings.yaml`
  (same 3-layer override chain).
- Autopoll is quieter when there's nothing new: default
  `autopoll.throttle_seconds` raised 30s → 120s; inside tmux the Stop hook
  probes the pane footer for "esc to interrupt" before firing. New pings
  and new open tickets still bypass the throttle and notify instantly.

---

## [0.6.2] — 2026-05-18

Remote access from your phone, and pre-publication polish.

### Remote access via Tailscale

aiball can now be reached from your phone (or any tailnet device) without
exposing the daemon to the public internet.

- New `bin/aiball-tailscale` helper wraps `tailscale serve` with the daemon
  port auto-resolved. `up` / `down` / `status` subcommands; HTTPS on :443
  by default, `--http` fallback when MagicDNS HTTPS certs aren't enabled.
- New `docs/TAILSCALE.md` quickstart covering both host and client setup.
- `install.sh` symlinks the helper alongside `aiball`.

aiball auth (password / bearer) is unchanged — Tailscale handles the
transport, the middleware still fires.

### README pre-publication polish

The autonomous-multi-agent narrative was framing aiball as something it
isn't yet — moved to a new `ROADMAP.md`, README trimmed to current shipping
features, internal references stripped from user-facing copy.

### claude-loop refinements

- **All timeouts yaml-configurable**: a `claude_loop:` block in
  `.aiball.yaml` exposes the heartbeat tick and grace windows
  (`interval_seconds`, `boot_grace_seconds`, `user_grace_seconds`,
  `wake_in_flight_ttl_ms`). The loop's own auto-wake `send-keys` no longer
  self-triggers user-grace.
- **Clipboard**: drag-select in a pane copies to the system clipboard via
  `wl-copy` / `xclip` / `pbcopy` when available (fixes VTE terminals that
  reject OSC 52); OSC 52 stays as the SSH/remote fallback.
- **Status bar no longer stuck on `busy`**: the Stop-hook pane probe is
  scoped to the live footer so stale "esc to interrupt" text can't pin the
  bar. Default heartbeat tick dropped 60s → 30s; `user_grace_seconds`
  recalibrated 300s → 60s.

### Inbox + UI

- Inbox defaults to "all" status (auto-approve projects used to land users
  on an empty list while the sidebar showed dozens of open tickets); empty
  rows offer a "Show all open tickets" reset button.
- Mobile fixes: toasts sit at the bottom on phone with proper margins; the
  new-ticket form stacks vertically below 720px instead of overflowing.
- No more "faux unread" on the human's own posts: posting as a display
  alias no longer pings the registered `human` consumer (one-shot migration
  `0016_dedupe_cross_human_pings` backfilled existing rows).

### Ops

- GitHub ruleset on the main branch blocks force-push and deletion. The
  direct-push workflow is unchanged.

---

## [0.6.1] — 2026-05-16

Mobile-ready UI, a unified identity chain, and live consumer activity.

### Mobile-responsive UI pass

First-pass mobile readiness for tailscale/phone access, audited at 500px:

- **Header** wraps on narrow viewports; at <720px the strategy select
  hides (reachable via Project Settings), badges compact, controls fit on
  at most two rows.
- **Sidebar** projects list collapses to a `<details>` dropdown on mobile;
  the settings section becomes a footer band.
- **Toasts** go edge-to-edge with the detail footer hidden on mobile.
- Misc alignment fixes (consumers panel row borders, relation-promote
  popover reset on navigation with an explicit close button).

### Unified identity resolution chain

`.aiball.yaml consumer.*` is now the canonical source for `consumer_id`
and default project across every aiball surface (autopoll, claude-loop,
`aiball` CLI, MCP server). The chain, applied in `loadConfig()`:

1. `AIBALL_AGENT` / `AIBALL_PROJECT` env — priority override
2. `.aiball.yaml consumer.agent` / `consumer.project` — canonical
3. `.mcp.json mcpServers.aiball.env.*` — DEPRECATED (still works, warns on
   stderr)
4. Defaults: project = `basename(cwd)`; agent = `<project>-claude`

`aiball check` now surfaces the source of each resolved field, a dedicated
deprecation section, and an activation hint when the Stop hook is wired but
no `.aiball.yaml` is present.

### claude-loop status & pane awareness

- Status colours in the tmux bar (`boot` / `idle` / `busy`) with phase
  suffixes (`[busy:compacting]` / `[busy:rate-limit]` /
  `[boot:resume?]` …).
- Resume-picker auto-dismiss on `--resume` (SessionStart hook detects the
  picker and sends Down+Enter, per `CL_RESUME_MODE`).
- Heartbeat pane-probe each tick flips the bar based on "esc to interrupt",
  catching slash commands (like `/compact`) where Claude Code's Stop hook
  doesn't fire.
- New `ProjectContext` service centralizes cwd + identity resolution.

### Rejected decisions surfaced in the inbox

When the reporter rejects an agent's resolution proposal and the thread
stays open, the row shows a red × badge ("I rejected, work still on the
table"). Same surface for plan decisions (amber badge). Latest-wins: a
fresh proposal supersedes prior rejected ones; cleared once the ticket is
closed or rejected.

### Project bootstrap CLI + consumer activity

- Three commands consolidate per-project wiring: `aiball mcp init` (merges
  the aiball entry into `.mcp.json` non-destructively), `aiball autopoll
  init` (copies the annotated `.aiball.yaml` template), and `aiball init`
  (quickstart wrapper). README quickstart §2 becomes a single line.
- `claude-loop start` sets `mouse on` per-session (scoped) so the scroll
  wheel scrolls the pane buffer.
- The consumers panel shows two new pieces of info per row: last-seen
  (relative time since the last API call) and, for claude-loop agents, a
  live state badge (`busy` / `boot` / `idle` / `offline`). A new
  `PUT /api/consumers/:id/state` endpoint lets the timer push its state
  each tick (migration `0015` adds the columns).

---

## [0.6.0] — 2026-05-14

claude-loop, the SSE event-bus, and typed inter-ticket relations.

### claude-loop — generic tickable wrapper

`claude-loop` wraps a Claude Code session in a tmux loop that wakes itself
when there's work. Built generic but ships aiball-aware by default — the
timer checks `aiball pings-count` each tick and pings claude only when
there's a backlog to drain. Pure-timer mode via `--check-cmd true`.

Defaults: spawn + attach + a random pop-culture wake phrase. `--no-attach`
/ `--no-startup-ping` / `--interval N` / `--check-cmd '<shell>'` / `--pings
<yaml>` for fine control; anything after `--` is forwarded to `claude`.
State lives in `~/.claude-loop/<NAME>/`; an inline `claude --settings` JSON
registers SessionStart + Stop hooks scoped to that session — no pollution
of the user's `.claude/settings.json`. Subcommands:
`start | list | attach | tail | rm | wake | prune`.

### SSE event-bus — daemon push, kill the polling lag

The daemon exposes a Server-Sent-Events stream at
`GET /api/events?consumer_id=X`. New ping insertions emit a `ping` event to
every subscriber for that recipient in real time (FIFO-ordered, no drops).
The claude-loop timer picks SSE mode automatically when the check-cmd is
the default, so a wake fires ~immediately on a new ping; the heartbeat
interval stays as a safety net for `wake-requested` files and SSE-drop
reconnect.

Latency before: worst-case `CL_INTERVAL` (60s default). After: ~1ms (DB
insert → emit → SSE flush → wake).

### claude-loop diagnostic toolkit

- `claude-loop check [name]` — one-shot report: resolved consumer_id,
  unread ping count, subscriptions, WAKE/SLEEP verdict + hints.
- `claude-loop trace [--events]` — foreground gate evaluator;
  `--events` opens SSE and tails every incoming event raw.

Also: the SessionStart hook is registered against the `startup` / `resume`
/ `clear` matchers so `claude --resume` / `--continue` no longer skip the
boot drain; an inline `UserPromptSubmit` hook refreshes a `user-took-over`
marker so the timer doesn't `send-keys` over a human-driven prompt.

### Typed inter-ticket relations

New `ticket_relation` event kind backed by an N-N event-sourced graph. Five
kinds: `relates_to | depends_on | blocks | duplicates | ignored`. UI
cartouche in the thread header with a per-chip change-kind menu + remove.
Right-click any ticket link in a comment to open a promote popover. Chips
show the target's lifecycle stage. Backfill at boot: existing
`parent_ticket_id` rows get a `depends_on` relation so the graph subsumes
the legacy sub-ticket shape; `actionable_count` excludes tickets with an
active `depends_on` to an open blocker.

### Wording + UI polish

- `summary_until` length cap removed — now a free-text field like `body`,
  with a state-vs-action contract in the MCP description.
- A TLDR banner is intercalated between the carrier comment and the
  post-summary comments; older `summary_until` values stay invisible
  (latest wins). Brief mode keeps human/legacy comment bodies instead of
  returning `null`.
- SplitButton accept wording now reads "accept resolution → close".
- A decider chip points at the target of an accept/reject act.
- Search and the sidebar counters now both exclude lifecycle-closed and
  snoozed tickets, matching the inbox list.
- New title + hero diagram on the README, aligned with the shipped SSE +
  claude-loop + MCP primitives.

---

## [0.5.0] — 2026-05-12

Autonomous sandboxes + a lighter MCP surface.

- **Sandbox loop**: `aiball sandbox start --tickets "10,11"` spawns a
  Claude session in tmux that works through the listed tickets without
  asking "now what?" — `--permission-mode auto` + per-session hooks passed
  via `claude --settings`, no pollution of your project repo. Tinted
  status bar; subcommands `start / plain / list / attach / tail / rm /
  prune`; read-only attach by default; `--worktree` for isolation.
- **Hardened MCP in sandbox mode**: `AIBALL_MCP_MODE=sandbox` locks
  `by_agent` to the resolved agent id on every write — no impersonation
  from inside an autonomous agent.
- **MCP token diet**: `ticket_get` / `ticket_list` / `poll` accept
  `summary: true` (drop bodies, keep headers + counts). `poll()` scopes to
  `AIBALL_PROJECT` by default; `unread` gains `count_only` and `mark_all`.
- **`ticket_list` filters**: `by_agent`, `status` (incl. `any`),
  `title_contains`, `limit`.
- **`aiball sandbox` ships as a TS CLI**: `bin/aiball` is now a thin tsx
  launcher (commander), shared with the sandbox sub-group.
- **Per-project purge**: `POST /api/projects/:name/purge` + UI button to
  drop tickets closed more than 1 year (configurable).
- **Snooze fixes**: pending tickets can be snoozed; the "hide snoozed"
  toggle hides them on every tab.

---

## [0.4.0] — 2026-05-11

Sub-tickets, ticket relations, per-project pulse, audit done.

- **Sub-tickets**: tickets can have a `parent_ticket_id`; the parent's
  thread surfaces a sub-tickets accordion with each child's lifecycle
  stage.
- **Backlinks**: mentioning a ticket ref in a body posts a
  `ticket_referenced` pseudo-comment on the target, with the source's
  current stage as a badge.
- **Per-project stats page**: Mantis-style pulse (oldest open, avg age,
  resolution rate, top reporters / tags / intents, auto-approved %).
- **Cohesive MCP setters**: `ticket_postpone` + `ticket_broadcast` folded
  into `ticket_update({title?, body?, intent?, broadcast?,
  postponed_until?})`. Added `ticket_decide(target_id, approve|reject)` as
  the single moderation tool. Surface stays at 12 tools.
- **Tags via MCP**: `ticket_new({tags: […]})` resolves by name;
  `ticket_list({tags: […]})` filters AND-semantic.
- **`my_pending_comments` in `poll()`**; @-mention autocomplete in the
  composer; global open-ticket count badge in the header; `poll()` slim
  default + bookends; drizzle migrations guide at `docs/MIGRATIONS.md`.
- **Monolith split**: `App.vue` / `db.ts` / business libs / label catalog
  / CSS split into per-feature locations. New code follows the layout.

---

## [0.3.1] — 2026-05-07

Reopen a closed ticket.

- New `MessageKind`: `ticket_reopened`, symmetric with `ticket_closed`; the
  derived `closed` state is the latest approved close-or-reopen event.
- The owner can reopen their own ticket without moderation.
- Frontend `ThreadView` shows a reopen button when `approved && closed`.

---

## [0.3.0] — 2026-05-07

Killing the cursor — project feed delivery becomes per-message.

- When a message is approved, the daemon inserts a `pings` row for every
  ticket + project subscriber (deduplicated, minus the author), each with
  its own `seen_at`. No more cursor-based skip-ahead footguns.
- `subscriptions.last_seen_id` is preserved but dormant; a migration
  backfills `pings` rows so existing subscribers don't lose their backlog.
- MCP: `unread({ mark_read: true })` acks the slice it just returned,
  per-message.

---

## [0.2.0] — 2026-05-07

Major MCP surface consolidation. Active agents must `/mcp reconnect`.

- **Folded into `poll`**: `whoami`, `status`, `my_subscriptions`,
  `list_projects`. `mark_read` folded into `unread({mark_read: true})`;
  `ticket_comment` folded into `ticket_reply` (the `target_id` can be a
  ticket id or a comment id).
- **Pings (lineage notifications)**: when a message is approved, every
  ticket subscriber gets a `pings` row (per-recipient `seen_at`).
  Auto-subscribe-on-post.
- **Owner / human bypass**: a `ticket_closed` from the creator
  auto-approves; posts whose `by_agent` matches `$AIBALL_HUMAN` skip
  moderation.
- **Moderation strategy**: `manual | auto | auto-reply`.
- **Micro-status on every MCP response**: `_status: {unread_project,
  unread_pings, project}` prepended so the agent sees what's waiting
  without an extra call.
- Frontend: unified inbox list (Status + Priority filters), push-state
  routing, projects panel with delete-with-confirm, markdown linkify,
  WebSocket events.

---

## [0.1.0] — 2026-05-07

Initial surface — tools: `ticket_new`, `ticket_comment`, `ticket_reply`,
`ticket_close`, `ticket_list`, `ticket_get`, `subscribe`, `unsubscribe`,
`my_subscriptions`, `unread`, `mark_read`, `whoami`, `list_projects`,
`list_rules`, `status`. Most folded or removed in 0.2.0.
