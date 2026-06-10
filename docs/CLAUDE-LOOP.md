# claude-loop

> Wrap a Claude Code session in a tmux loop that wakes itself when
> there's work to drain. Default-coupled to aiball (the wake-up gate
> polls `aiball pings-count`); generic via `--check-cmd <shell>`.

---

## What it is

A pseudo "timer hook" for Claude Code. Claude Code is event-driven —
no native `Tick`/`Periodic` hook — but you sometimes want a session
that quietly drains pings as they arrive without you typing each
prompt. `claude-loop` adds that behavior externally:

- **tmux** owns the lifetime of the session (`cl-<NAME>` session
  named after the loop).
- **An inline `claude --settings '<JSON>'` block** installs two
  hooks scoped to that session only (no pollution of your
  `~/.claude/settings.json`):
  - `SessionStart` — fires after claude has booted.
  - `Stop` — fires at the end of every claude turn.
- **A detached timer process** ticks every `CL_INTERVAL` seconds.

Each surface asks the same question — _is there work?_ — by running
the loop's `--check-cmd`. Exit 0 → wake claude with a random
pop-culture phrase. Non-zero → mark idle, wait.

---

## Permissions (unattended runs)

A loop has no human on hand to answer Claude Code's permission prompts,
so it launches the inner session with `--permission-mode auto`: every
tool call is classifier-checked and runs **without a prompt**. A mode
that *prompts* (`default` / `acceptEdits` / `plan`) would stall the loop
at the first tool call. Override the whole launch command (binary +
flags before `--settings`) via `CL_CLAUDE_CMD` — e.g. to pick another
mode such as `bypassPermissions`.

The per-session `--settings` block carries **only hooks**; it never
writes permission keys. So unattended autonomy comes **entirely** from
`--permission-mode` — aiball does not set, require, or read any global
permission-bypass setting. (If a `skipAutoPermissionPrompt`-style key is
sitting in your `~/.claude/settings.json`, it is not aiball's and is not
needed; a plain `claude` you start yourself just uses your normal
config.)

---

## Core cycle

```
                           ┌─────────────────────────────┐
       boot ──► SessionStart hook ──► check-cmd ?        │
                              │       ├─ exit 0 → send-keys phrase
                              │       └─ non-0  → stamp idle-since (ipc)
                              ▼
                    ┌────────────────────────┐
                    │  claude waits at prompt │ ◄─────┐
                    └──────────┬──────────────┘       │
                               │ user types OR        │ send-keys
                               │ send-keys arrives    │
                               ▼                      │
                    ┌────────────────────────┐        │
                    │  claude runs a turn     │        │
                    └──────────┬──────────────┘        │
                               │                       │
                               ▼                       │
                       Stop hook ──► check-cmd ?       │
                              │     ├─ exit 0 → send-keys phrase ──┘
                              │     └─ non-0  → write idle-since
                              ▼
                      (back to "waits at prompt")

         in parallel, every CL_INTERVAL seconds:
         ┌────────────────────────────────────────────────┐
         │ timer process: idle-since present?             │
         │   ├─ no  → skip tick (claude is busy)          │
         │   └─ yes → human present? (user-grace /        │
         │            human-typing / busy-defer)          │
         │            ├─ yes → skip tick (yield to human) │
         │            └─ no  → wake-requested / check-cmd?│
         │                     ├─ yes → wake phrase       │
         │                     └─ no  → skip (stay idle)  │
         └────────────────────────────────────────────────┘
```

The "human present?" branch is the keystroke-detection gate — see
[Human presence & keystroke detection](#human-presence--keystroke-detection).

**Three wake sources**, all gated through the same `checkHasWork()`
function (except `wake` which is unconditional):

| Surface         | When                              | Latency from event arrival |
|-----------------|-----------------------------------|----------------------------|
| Stop hook       | Just after claude finishes a turn | ~immediate                 |
| SessionStart    | After claude boots                | ~immediate (once)          |
| Timer tick      | Every `CL_INTERVAL` seconds       | up to `CL_INTERVAL` sec    |
| `claude-loop wake` | Manual external trigger        | up to `CL_INTERVAL` sec    |

The Stop hook is the tightest drain: as soon as claude returns to
the prompt with new work waiting, it re-fires without waiting for
the timer.

---

## Quickstart

```bash
# Spawn + attach (default). Ctrl-B D to detach.
claude-loop --name play

# Slower tick (every 5 min). Default check-cmd = aiball pings.
claude-loop --interval 300

# Bound to a non-aiball check
claude-loop --check-cmd 'curl -fs http://localhost/api/queue?count=1 | jq -e .pending'

# Pure timer (ping every tick, no gating)
claude-loop --check-cmd true

# Detach immediately, don't send the boot ping
claude-loop --no-attach --no-startup-ping

# Pass options to claude itself (after --)
claude-loop -- --model opus -p "kick off drain"
```

Lifecycle:

```bash
claude-loop list                       # alive/dead + state summary
claude-loop status [name]              # connection type, default agent, daemon reachability
claude-loop tail <name> --lines 30     # last N lines of the claude pane
claude-loop tail <name> --timer        # detached timer's stdout log
claude-loop attach <name>              # tmux attach
claude-loop wake <name>                # force the next tick (bypass check-cmd)
claude-loop reload [name]              # respawn the timer in place (keeps claude)
claude-loop restart [name]            # hard restart: kill + relaunch from the plate
claude-loop stop [name]               # clean stop: kill claude/tmux + exit, KEEP state
claude-loop rm <name> [--force]        # stop + DELETE the state dir
claude-loop prune                      # interactive cleanup of orphans
```

**Signals** (sent to the timer pid, `$state/timer.pid`) mirror the lifecycle
verbs so a loop is controllable without the CLI: `HUP` = restart, `USR2` =
reload, `TERM` = stop. A running loop can also be **stopped remotely** from the
aiball web UI (the Consumers page shows a stop button on each live loop) — handy
when you have no shell on the loop's host.

---

## check-cmd contract

Any shell snippet:

- **Exit 0** = "there is work to drain" → wake claude.
- **Non-zero** = "nothing to do" → stay idle.

Default: `aiball pings-count -q`. The CLI subcommand prints the
unread-ping count and exits 0 when > 0. When this exact string is
the check-cmd, both the timer and the hooks bypass the subprocess
fork and call `AiballClient.pingsCount()` directly in-process
(cached client, keep-alive socket).

Special values:
- `true` (or empty) → wake unconditionally on every tick (pure
  timer mode).

Custom shells (e.g., file watchers, queue checks, hybrid logic) get
shelled out per tick — no fastpath, but anything works.

---

## Human presence & keystroke detection

`claude-loop`'s one hard rule: **never `send-keys` a wake over a human
who's at the keyboard**. Injecting "What's up, Doc?" into the middle of
a prompt you're typing is worse than useless. Three signals keep the
loop deferential, coarsest to finest.

### 1. User-grace (submit-time)

The `UserPromptSubmit` hook fires on every prompt submitted in the pane
— yours *and* the loop's own auto-wake. When the prompt came from a
**human**, the hook stamps the `user-took-over` marker (mtime = now).
The timer and the Stop hook check `userIsTakingOver()` and skip their
auto-wake while that marker is fresher than `CL_USER_GRACE_SEC`
(default **60s**). Every prompt you submit re-arms the window, so an
active session stays wake-free until you've been quiet for a minute.

The catch: the loop's *own* wake also triggers
`UserPromptSubmit`, which would stamp `user-took-over` and freeze the
next wake for a full grace window — self-inflicted. Fix: every wake path
stamps `ipc.wakeInFlightAtMs` right before injecting ; the hook sees
the in-memory latch (TTL `CL_WAKE_IN_FLIGHT_TTL_MS`, default 2s),
recognizes the prompt as the loop's own, and skips the `user-took-over`
stamp.

### 2. Live keystroke detection

User-grace only updates at *submit* time. To know a human is typing
**right now** — before they hit Enter, even mid-turn — the loop reads
`ipc.humanTypingAtMs` (TTL `HUMAN_TYPING_TTL_SEC`, 5s). Two feeders,
best-to-worst :

- **PTY proxy (preferred).** When the pane runs under the PTY proxy,
  every real text keystroke is detected at the terminal layer and emits
  a `touch_marker` event over `loop.sock` ; the timer stamps
  `ipc.humanTypingAtMs`. Works even while claude is streaming, and the
  proxy's own socket-injected wakes never trip it. Full mechanism in
  [`PTY-PROXY.md`](./PTY-PROXY.md).
- **Degraded pane-diff (fallback).** With no proxy, the timer's
  `detectHumanTyping` poll captures the pane every ~1.5s and stamps
  `ipc.humanTypingAtMs` when the prompt area changes at idle. Idle-only,
  and can't separate your keystrokes from the loop's own injection as
  cleanly — exactly the blind spot the proxy was built to close.

### 3. The tmux bar word — `stop` / `boot` / `wait` / `loop`

The human-presence word on the bar reads **AFK state ONLY** —
user-grace gates auto-wakes silently behind the scenes but doesn't
paint a colour here. F9 is the single visible control.

| Word   | Colour | Meaning                                                       |
|--------|--------|--------------------------------------------------------------|
| `stop` | red    | a human is typing **now** (`ipc.humanTypingAtMs` < 5s)       |
| `boot` | yellow | the launch-grace window — claude is still loading            |
| `wait` | yellow | F9-armed hold (10-min auto-release or indefinite)             |
| `loop` | green  | autonomous, gate open (managed mode / `--no-wait`)           |

The timer's `BarRenderer` is the single writer of every tmux bar
option (`@cl_human`, `@cl_state`, `status-bg`, `@cl_afk_state`, etc.).
It subscribes to `ipcState` changes and repaints diff-guardedly, so the
bar is always coherent with the in-memory truth — no race between proxy
and timer like the older two-writer setup had.

The status-right segment shows the AFK chunk in matching colours :

| State                  | Status-right chunk     | Bar word colour |
|------------------------|------------------------|-----------------|
| autonomous (AFK on)    | `AFK:F9` (dim)         | green `loop`    |
| F9-armed 10 min        | `9m NOT AFK:F9` (yellow) | yellow `wait` |
| F9-armed ∞             | `∞ NOT AFK:F9` (red)    | yellow `wait` |

The label flip `AFK:` ↔ `NOT AFK:` matches the literal "Away From
Keyboard" reading — when the bar is `loop` the human is presumed
away (claude runs), when `wait` the human is present and holding
the loop.

### The take-over workflow — what happens when you type

Typing in the pane refreshes the **user-grace** marker
(`CL_USER_GRACE_SEC`, default **600 s / 10 min**). user-grace gates :

- auto-pings (timer.tryWake skips while it's fresh),
- `AskUserQuestion` (still allowed for the same window — the #619
  collapse merged the historical ask-grace into user-grace).

user-grace is **silent** on the bar — typing prints `stop` red for
~5 s then the bar returns to whatever the AFK state says (usually
`loop` green, since typing alone doesn't arm AFK). The auto-wake
suppression keeps running invisibly. To make the hold *visible* and
controllable, press F9.

Time-line of a single human interaction (no F9) :

```
T=0   you type something on the pane
      ├─ bar = stop (red, ~5s)
      ├─ user-took-over marker mtime = now (silent gate)
      │
T+5   typing stopped
      └─ bar = loop (green) ← but auto-wakes still frozen behind the scenes
      │
T+600 user-grace expired
      └─ auto-pings resume (no visible bar change — was already `loop`)
```

(Back-compat : a project that still sets `ask_grace_seconds` in
`.aiball.yaml` is honored — the deferential window widens to
`max(user_grace_seconds, ask_grace_seconds)`, never shrinks. New
configs should set only `user_grace_seconds`.)

**Boot-grace finale.** The boot phase lifecycle is owned by the
`BootMachine` XState actor (see [`SM-NETWORK.md`](./SM-NETWORK.md)).
When it transitions to `sealed`, the loop flips the bar based on the
launch mode (so the steady state matches the user's intent, not
whatever happened during loading) :

- `--wait` (managed default) → arm `NOT AFK 10m` automatically →
  bar reads `wait` yellow with the 10-minute countdown in the
  status-right chunk.
- `--no-wait` (eager drain) → leave AFK off → bar reads `loop`
  green and the timer starts firing wakes.

During the boot-grace window itself, the bar BG stays `[boot]`
yellow regardless of transient pane content — `claude`'s splash
or a quick `esc to interrupt` no longer flips the bar to grey or
blue mid-load.

**F9 cycles three states ; typing arms the 10-minute hold.** AFK
has three user-visible states and two inputs (the implementation
lives in `afk-service.ts` ; see [`SM-NETWORK.md`](./SM-NETWORK.md)
for the planned AfkController state machine) :

- **F9** = tristate cycle `AFK → NOT AFK 10m → NOT AFK ∞ → AFK`.
- **Text keystroke / ESC** = arm or refresh the `NOT AFK 10 min`
  countdown — except in `∞` mode, where typing is a no-op (only
  F9 releases the indefinite hold).

State transitions :

| From          | F9                | Typing                   | Timer expiry |
|---------------|-------------------|--------------------------|--------------|
| AFK           | → NOT AFK 10m     | → NOT AFK 10m            | n/a          |
| NOT AFK 10m   | → NOT AFK ∞       | reset countdown to 10:00 | → AFK        |
| NOT AFK ∞     | → AFK (clear)     | no-op                    | n/a          |

F9 on the `∞ → AFK` leg also clears `user-took-over` so the wake
gate frees up alongside the visible release. The 10-minute timer is
absolute (stored as expiry timestamp), so re-paints reflect the
real remaining time and the toggle never accidentally resets an
in-flight countdown.

(Orthogonal third gate : the Stop hook / timer also read `esc to
interrupt` in the pane footer and arm a `busy-defer-until` window via
`ipc.busyDeferUntilMs` so a wake isn't fired while claude is visibly
mid-turn. That's claude-busy, not human-present, but it's the other
reason a tick may skip.)

---

## Wake gates

Beyond the "is there work?" check, you can attach **gates** — checks run each
heartbeat whose message is **prepended to the wake** when they trigger, so the
agent sees e.g. "you have an un-merged PR" before picking up new work.
Configured under `claude_loop.gates` in `.aiball.yaml`; two forms in one list:

- **built-in** (`type: unmerged_pr`) — a pre-wired detector, no shell to write.
- **custom** (`name`, `cmd`, `message`) — your own check: exit 0 = triggered,
  and the command's stdout (if any) overrides the static `message`.

`blocks: true` makes the wake **lead** with the gate and drop the "engage"
directive ("resolve this before taking new work"); the default is a warn (the
message is just surfaced alongside the normal CTA). Built-in wording is
overridable per project via the `prompts:` block (slot `gate_<type>`, e.g.
`gate_unmerged_pr`), tone-aware, with detector placeholders like `{count}`.

---

## State layout

`~/.claude-loop/<NAME>/` (override via `CLAUDE_LOOP_STATE_ROOT`):

All runtime state — pane-busy, idle-since, AFK mode, human-typing
timestamps, wake-in-flight latch, busy-defer expiry, boot-complete seal,
etc. — lives in the timer's **in-memory `ipcState`**. Hook subprocesses
and the PTY proxy read it via `loop.sock` (UDS `queryLoopState` request)
or receive it pushed via WebSocket. No marker files, no `existsSync`
fallback : the timer is the single authoritative writer.

Files that DO live on disk are config (set once at start) or
liveness markers (PID-stamped) :

| File              | Writer          | Purpose                                   |
|-------------------|-----------------|-------------------------------------------|
| `plate.json`      | cli on start    | structured config (interval, check_cmd…)  |
| `env`             | cli on start    | bash-sourceable CL_* env vars             |
| `pings.yaml`      | cli on start    | copy of the wake-phrase pool              |
| `proxy-alive`     | PTY proxy       | proxy is really fronting claude (PID-stamped) |
| `kill-on-exit.sh` | cli on start    | bash trap script sourced in the tmux pane wrapper — SIGKILLs timer + proxy when claude exits |
| `zen`             | cli `zen` / `touch` | mute markers — keeps the wake gate closed (file-only by design : safety override that must survive process restarts) |
| `timer.pid`       | cli on start    | pid of the detached timer (used by `rm`)  |
| `timer.log`       | timer (stdout/err) | inspect via `tail --timer`             |

The hooks and the timer all read the same `env` file so they share
`CL_NAME`, `CL_STATE_DIR`, `CL_INTERVAL`, `CL_CHECK_CMD`, `CL_PINGS`,
`CL_NO_STARTUP_PING`.

### Satellite lifecycle — kill-on-exit, watchdog, orphan sweep

`claude-loop` spawns two background processes per loop alongside the
foreground `claude` binary: the **timer** (Node, runs the wake gate +
SSE subscriber) and the **PTY proxy** (Python, fronts claude to intercept
typing and inject wakes). David's directive (#783): when `claude` exits,
these satellites must die — leftover timers and proxies bind to the same
state-dir as the next start and cause divergent behaviour (stale code
running, stale F9 events, double SSE subscriptions).

Four mechanisms together enforce "no orphan satellites":

1. **Bash trap EXIT in the pane wrapper.** The cli writes
   `kill-on-exit.sh` under the state-dir at start time and the tmux
   inner command sources it before launching the proxy/claude chain.
   When claude exits (Ctrl-D, `/exit`, crash), bash hits the EXIT trap
   which first sends a cooperative `{kind:"shutdown"}` frame over
   `loop.sock` (the timer self-exits cleanly on receipt), then SIGKILLs
   `timer.pid` + `proxy-alive`'s pid as backstop. A legacy `rm -f` of
   long-gone marker files is kept for defence-in-depth (no-op on fresh
   installs — all transient state lives in the timer's in-memory
   `ipcState` now). The bash process stays alive as the pane parent
   precisely so the trap can fire — switching the launch from
   `exec proxy` to plain `proxy` adds one bash process per pane
   (negligible) but is what lets EXIT actually trigger.

2. **`tmuxAlive` watchdog at 2s in the timer.** The timer's heartbeat
   already calls `tmuxAlive()` every interval (default 30s); a faster
   `setInterval(2000)` in `mainSse` collapses an orphan within seconds
   when the bash trap couldn't run — e.g. `tmux kill-session` blasted
   the pane outright, the wrapper got `kill -9`, the OS reaped the
   pane on user logout. The probe runs `tmux has-session -t <name>`,
   exits via `cleanShutdown` if gone. Cheap (one subprocess every 2s).

3. **SHA-mismatch self-respawn.** Same 2s watchdog reads the
   install-root SHA from `installRootSha()` and compares it to the
   plate-recorded boot SHA. On mismatch the timer respawns itself via
   the existing `selfReloadIfStale` path. This catches cases where
   tsx-watch held a stale module cache (tryPanic re-firing after the
   delete commit, observed live on aiball-dev 2026-06-04) — the
   process restart bypasses any in-memory leftover.

4. **Orphan sweep at `claude-loop start`.** Before spawning a fresh
   timer/proxy pair, `sweepOrphans(sd)` scans `/proc/*/environ` on
   Linux for any process whose `CL_STATE_DIR` matches the target
   state-dir and SIGKILLs them. Defends against orphans accumulated
   under pre-fix code (seen live: 14 zombie tsx processes from earlier
   in the day). `cmdReload` and `cmdRestart` invoke the same sweep
   after killing the named timer pid.

`cmdReload` uses **SIGKILL** for the old timer pid, not the default
SIGTERM (fix for #780). The timer's SIGTERM handler runs
`cleanShutdown` which also kills the tmux session — exactly what
reload-not-restart is supposed to avoid. SIGKILL skips the handler,
the new timer rebinds `timer.pid` + `loop.sock` cleanly, the watchdog
on the new process reaps any stale marker on the next 2s tick.

The orphan-sweep code is Linux-only (`/proc` reader). Mac/Windows
ports tracked as a follow-up — `kill -0` based lockfiles look like
the right cross-platform path.

### WebSocket heartbeat on `loop.sock`

The timer is the SSOT for the loop's state and owns `loop.sock` (UDS
WebSocket). Three clients connect to it in steady state: the PTY
proxy's view-push reader, the PTY proxy's event emitter, and the
hook subprocesses (Stop, SessionStart, UserPromptSubmit) that POST
events one-shot per fire. Without a liveness probe a connection can
linger half-open for arbitrarily long when one side dies — the
in-kernel TCP stack on UDS won't send FIN until the next write
fails. Symptoms observed live (#788): F9 worked once per ~30s on
aiball-dev because the proxy emitter never noticed the server-side
socket was dead, kept silent-writing into the void until the next
emit triggered EPIPE.

Server side (`src/claude-loop/ipc-events.ts:listenEvents`):
- `setInterval(15s)` per connection: marks `isAlive=false`, sends
  `ws.ping()`. If the next tick finds `isAlive` still false, the
  server calls `ws.terminate()` and clears the interval.
- `isAlive` resets on ANY inbound frame — `pong`, `ping`, or
  `message`. The "any frame" leniency (#788) keeps connections
  alive for write-only clients (e.g. the legacy `_ProxyEventEmitter`
  that didn't read pongs); a client actively sending events is
  demonstrably alive even when its read buffer is empty.

Client side (Python proxy):
- `_ViewPushClient` runs a recv loop in a background thread. The
  `websocket-client` lib auto-pongs incoming pings as part of
  `recv()` processing, so the reader handles liveness for free.
- `_ProxyEventEmitter` no longer holds its own socket. It calls
  `_view_push_client.send(payload)` on the shared connection
  (`9052280`). When the recv loop detects close + reconnects, the
  emitter's next send goes through the new socket.

Constants live in `src/claude-loop/ipc-events.ts`:
`HEARTBEAT_PING_MS = 15_000`. A dead client is reaped within 30s
max (one ping + one tick).

### FIFO mark-seen-at-inject

When a wake fires on a FIFO event (an unread comment / lifecycle /
ticket-created head), the head's `message_id` is marked seen the
moment the inject crosses the dedup gate, not at agent-side
`ticket_get`. David's framing (#749): "un ping envoyé est forcément
seen" — a delivered wake IS the agent's read of the event, no
separate ack needed.

Flow:
1. `buildContextPhrase` (`src/claude-loop/state.ts`) pops the oldest
   unread row via `client.unread(project, 1)`. The row's `id`
   (= the `_messages.id` for comments, the `tickets.id` for
   ticket_created heads) is returned alongside the phrase as
   `ContextPhraseResult.headMessageId`.
2. `sendKeys` (`src/claude-loop/timer.ts`) plumbs it into
   `injectWakePhrase`'s `onWillInject` callback.
3. `onWillInject` fires ONLY after the dedup gate passes (the wake
   is actually going out). It calls
   `client.markMessageSeen(headMessageId)` fire-and-forget — the
   ping leaves the unread queue immediately, the next wake fetches
   a different head.

Agent-side `ticket_get(N)` still has a role: it marks ALL the
ticket's other pending events seen at read time (via the existing
`markTicketRead` path) using the snapshot `upToId` so events that
landed AFTER the read aren't accidentally swept. So the head fires
at inject (one event = one wake), the rest of the thread is pruned
on consult.

Two consequences:
- A wake that's dedup-skipped doesn't prune (the `onWillInject`
  fires only on real inject) — the head stays available for the
  next attempt.
- A backlog wake (no FIFO head, fired via `?backlog=1`) sets
  `headMessageId=null` and records `recordBacklogWake(ticket_id)`
  instead — that's the cooldown clock for #786.

### One live loop per (cwd, agent)

Two `claude-loop start` for the **same agent in the same directory** is
unsupported, and made **impossible** at start time. The plain live-loop check
(`findLiveLoopForCwdAgent`) is a check-then-spawn — two concurrent starts could
both pass it before either registered its tmux session. So `start` first takes
an **atomic lock**:

- `~/.claude-loop/.start-lock-<sha1(cwd, agent)>` is created with `O_EXCL`
  (atomic "create iff absent") **before** the live-loop check + spawn. Only one
  concurrent start wins; the loser sees a live holder and refuses.
- The lock is held for the start process's lifetime; once it exits, the tmux
  session is the source of truth and `findLiveLoopForCwdAgent` guards the steady
  state, so the lock only needs to cover the spawn window.
- A **stale** lock left by a start that crashed mid-spawn self-reclaims: the
  holder pid is recorded in the lock and a dead pid is reclaimed transparently.
- `pruneDeadStateDirs` skips dotfiles so it never deletes a live lock.
- `--force` bypasses the lock (and the check) — explicit override.

Granularity is **(cwd, agent)**: a different agent may still run its own loop in
the same directory. The lock logic is pure/injectable (`src/claude-loop/start-lock.ts`,
unit-tested in `start-lock.test.ts`).

---

## Drained-backlog reminders

The wake gate normally fires on **pings** or **actionable** tickets (work in
your court). When those are both 0 but `open > 0` — a backlog entirely awaiting
the **human** (pending decisions, you-replied-last, blocked) — the loop is
"drained" and reminds **once** by default (david krwnqu); the count is also
visible on the sidebar. Set `drained_strategy: silent` to opt out of the nudge.

`claude_loop.drained_strategy` opts into a throttled reminder so a forgotten
gated backlog doesn't sleep forever. Spec `kind[:PT…[/PT…]]` (ISO-8601), parsed
by the pure `drained-strategy.ts`:

| strategy | when it wakes (drained = actionable 0, open > 0) |
|----------|--------------------------------------------------|
| `silent` | never — opt out of the nudge entirely |
| `once` *(default)* | one wake when the pool empties, then quiet until the landscape moves |
| `stale[:PT2H]` | auto-memo: only when the backlog is untouched for > the window (uses `last_actor_at`) |
| `backoff[:PT10M[/PT1D]]` | first at +base, gap doubles (base, 2×, 4×…) up to cap; resets when the landscape moves |
| `persistent[:PT30M]` | every eligible tick while `open > 0`, spaced ≥ param |

The shared primitive is the **`landscape_hash`** — `sha1` of the sorted
`<id>:<last_actor_at>` of the agent's open tickets, computed server-side in
`listProjectsDetailed` behind `&landscape=1` (no extra query, no cache). It is
the single signal for both:

- **reset** of the drained strategy (hash changed → backlog moved → re-arm), and
- **set-aware dedup** of the *actionable* wake leg (`last-open-wake-hash`) —
  replacing the count watermark, which missed swaps (one ticket leaves your
  court while another enters at a constant count).

Only the **timer** evaluates the drained branch (heartbeat-owned → sole writer
of `drained-state`, no cross-process race with the hooks).

---

## Wake phrases

Random pick per wake from `config/defaults/claude-loop-pings.yaml`:

```yaml
ping_messages:
  - "What's up, Doc?"
  - "Wake up, Neo."
  - "Hello, Dave."
  - "Make it so."
  - "Allons-y!"
  ...
```

20 default pop-culture phrases ship; override per-loop with
`--pings /path/to/custom.yaml`. The phrase is purely cosmetic —
claude reads "user typed X", inspects its context, decides what to
do. The wrapper doesn't try to know what "work" is.

---

## Files

```
bin/claude-loop                         # thin bash launcher → tsx
src/claude-loop/
  cli.ts                                # Commander CLI surface; wires hooks + PTY proxy
  state.ts                              # Plate + markers + grace/typing helpers + wake phrases
  project-context.ts                    # resolve cwd + aiball identity (agent, project)
  session-start-hook.ts                 # boot gate: check-cmd → ping or idle
  stop-hook.ts                          # turn-end gate: same logic + busy-defer
  user-prompt-submit-hook.ts            # human-submit → user-took-over (user-grace)
  pretooluse-hook.ts                    # gate AskUserQuestion in a headless loop
  timer.ts                              # detached ticker; AiballClient fastpath; typing poll
  error-backoff.ts                      # exponential retry on pane crash (rate-limit/api-error)
  pty-proxy.py                          # Unix PTY proxy: live keystroke detection (see PTY-PROXY.md)
config/defaults/claude-loop-pings.yaml  # default wake phrases + prompt templates
windows/cl-pty-proxy/                    # Windows ConPTY proxy (Rust, named pipe)
docs/CLAUDE-LOOP.md                     # this file
```

Install symlinks `~/.local/bin/claude-loop` alongside `aiball` and
`aiball-mcp` (see `install.sh`).

---

## Properties

- Three wake surfaces share the same `checkHasWork()` contract,
  predictable behavior across boot / drain / tick.
- Hooks scoped to one session via inline `--settings` JSON — zero
  pollution of the user's global Claude Code config.
- Timer is decoupled from the tmux process tree (`nohup` + `unref`),
  survives detach but dies cleanly when tmux exits (polls
  `has-session`).
- Generic-by-design: any shell can serve as `--check-cmd`; the
  aiball default is just the most common case.
- Wake-gate fastpath: when the default check is in use, the timer
  reuses `AiballClient` in-process instead of forking a subprocess.

---

## Limits

- **Polling cost.** 1 check-cmd run per loop per `CL_INTERVAL`.
  10 loops × 60s = 600 checks/hour, fine for the default
  (`AiballClient.pingsCount()` is a 1-HTTP-call probe).
- **One claude per loop.** Each loop holds its own context window;
  no batching.
- **tmux required.** No `screen` fallback yet (would be a small
  refactor — `MUX_CMD` is already a configurable constant).
- **Hooks fire only inside their own loop session.** A SessionStart
  hook from one loop doesn't see another loop's state.

---

## See also

- `docs/PTY-PROXY.md` — the pseudo-terminal proxy that powers live
  keystroke detection (the `ipc.humanTypingAtMs` stamp), telling a human
  typing apart from claude's output and from the loop's own injection.
  `docs/PTY-PROXY-WINDOWS.md` covers the Rust ConPTY port.
- `docs/SANDBOX.md` — `aiball sandbox`, the aiball-specific
  specialization that predates `claude-loop`. Refactoring it to use
  `claude-loop` underneath is a noted follow-up.
- `CHANGELOG.md` — narrative history (`[Unreleased]` section
  covers this work).
- `MCP-CLIENT.md` — agent-facing docs on aiball MCP usage; the
  default check-cmd (`aiball pings-count`) ties claude-loop to the
  flows described there.
