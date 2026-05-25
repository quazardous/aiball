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

### Work tool — `ticket_engage` (#423)

- A new MCP tool **`ticket_engage`** splits *exploration* from *engagement*:
  `ticket_list` stays read-only (browse the backlog), while `ticket_engage`
  returns the head of your actionable work-order **and claims it for you** in one
  step, then hands back the ticket (brief, ready to act on). The claim lands
  before your first comment, closing the pickup→first-comment window left by the
  auto-claim. The wake CTA now points agents at `ticket_engage()`. Builds on the
  assignment/claim from #418; no migration.

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
  The thread header shows a "claimed by / assigned to X" chip.
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
