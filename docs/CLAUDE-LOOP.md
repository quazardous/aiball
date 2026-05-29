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
                              │       └─ non-0  → write idle-since
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
touches a `wake-in-flight` marker right before injecting; the hook sees
it (TTL `CL_WAKE_IN_FLIGHT_TTL_MS`, default 2s), recognizes the prompt as
the loop's own, and skips the `user-took-over` stamp.

### 2. Live keystroke detection (`human-typing`)

User-grace only updates at *submit* time. To know a human is typing
**right now** — before they hit Enter, even mid-turn — the loop keeps a
near-live `human-typing` marker (TTL `HUMAN_TYPING_TTL_SEC`, 5s). Two
feeders, best-to-worst:

- **PTY proxy (preferred).** When the pane runs under the PTY proxy,
  every real text keystroke is detected at the terminal layer and stamps
  the marker — works even while claude is streaming, and the proxy's own
  socket-injected wakes never trip it. Full mechanism in
  [`PTY-PROXY.md`](./PTY-PROXY.md).
- **Degraded pane-diff (fallback).** With no proxy, the timer's
  `detectHumanTyping` poll captures the pane every ~1.5s and stamps the
  marker when the prompt area changes at idle. Idle-only, and can't
  separate your keystrokes from the loop's own injection as cleanly —
  exactly the blind spot the proxy was built to close.

### 3. The tmux bar word — `stop` / `wait` / `loop`

Both signals collapse into one human-presence word on the status bar
(`humanPresenceWord`):

| Word   | Colour | Meaning                                                       |
|--------|--------|--------------------------------------------------------------|
| `stop` | red    | a human is typing **now** (`human-typing` < 5s)              |
| `wait` | yellow | auto-pings **frozen** *and* `AskUserQuestion` allowed — boot-grace at launch, the user-grace window post-keystroke, or explicit AFK |
| `loop` | green  | autonomous, gate open (managed mode / `--no-wait`)           |

When the proxy is alive it paints this segment live (instant on the
first keystroke); otherwise the timer paints it from the markers.

### The take-over workflow — what happens when you type

A single grace window drives **both** the auto-wake gate and the
`AskUserQuestion` gate (since the #619 collapse — the two were a
distinction without a difference once both gates honored the longer
window).

- **user-grace** (`CL_USER_GRACE_SEC`, default **600s / 10min**) —
  while the `user-took-over` marker is fresher than this, the bar
  reads `wait` (yellow), auto-pings stay frozen, and
  `AskUserQuestion` dialogs stay allowed. The marker is refreshed on
  every text keystroke, so typing keeps the loop deferential.
- Past user-grace : bar `loop` (green), auto-pings resume, an
  `AskUserQuestion` would be denied and redirected to the aiball
  ticket thread.

Time-line of a single human interaction :

```
T=0   you type something on the pane
      ├─ bar = stop (red, ~5s)
      ├─ user-took-over marker mtime = now
      │
T+5   typing stopped
      └─ bar = wait (yellow) ← auto-wakes frozen, AskUserQuestion allowed
      │
T+600 user-grace expired
      └─ bar = loop (green) ← autonomous again
```

(Back-compat : a project that still sets `ask_grace_seconds` in
`.aiball.yaml` is honored — the deferential window widens to
`max(user_grace_seconds, ask_grace_seconds)`, never shrinks. New
configs should set only `user_grace_seconds`.)

**F9 to release early.** The AFK key (default `f9`, configurable via
`.aiball.yaml claude_loop.afk_key`) toggles an explicit AFK marker
that bypasses both windows :

- F9 (off → on) : bar = `wait` indefinitely, auto-pings frozen,
  `AskUserQuestion` denied. "I'm AFK, redirect questions to the
  ticket thread."
- F9 (on → off) : marker cleared, bar reverts to `loop` (or whatever
  the natural state computes to). Any text keystroke ALSO clears the
  AFK marker.

So the rule of thumb : type to engage (locks the loop out for up to
10 minutes), F9 to either *force* lock-out beyond that or *release*
faster than the natural decay.

(Orthogonal third gate : the Stop hook / timer also read `esc to
interrupt` in the pane footer and arm a `busy-defer-until` window so
a wake isn't fired while claude is visibly mid-turn. That's
claude-busy, not human-present, but it's the other reason a tick
may skip.)

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

| File              | Writer          | Purpose                                   |
|-------------------|-----------------|-------------------------------------------|
| `plate.json`      | cli on start    | structured config (interval, check_cmd…)  |
| `env`             | cli on start    | bash-sourceable CL_* env vars             |
| `pings.yaml`      | cli on start    | copy of the wake-phrase pool              |
| `idle-since`      | Stop / SessionStart sleep branch | claude is at prompt since X |
| `wake-requested`  | `claude-loop wake` | one-shot trigger for the next tick    |
| `user-took-over`  | UserPromptSubmit hook | last HUMAN submit (user-grace gate)    |
| `wake-in-flight`  | timer / Stop before send-keys | "this wake is ours" (≤2s) |
| `human-typing`    | PTY proxy / timer poll | a human is typing now (TTL 5s)        |
| `inject.sock`     | PTY proxy       | UDS the proxy listens on for wake injection |
| `proxy-alive`     | PTY proxy       | proxy is really fronting claude (PID-stamped) |
| `busy-defer-until`| Stop hook       | absolute time the wake-defer gate reopens |
| `last-wake-at`    | any wake path   | wake-coalesce window                      |
| `last-wake-hint`  | any wake path   | dedup identical SSE pings                 |
| `last-open-wake-count` | wake path  | open-ticket count watermark — fallback    |
| `last-open-wake-hash`  | wake path  | landscape signature watermark — set-aware dedup |
| `drained-state`   | timer only      | drained-strategy state `{hash,armedAt,wakeAt,step}` |
| `timer.pid`       | cli on start    | pid of the detached timer (used by `rm`)  |
| `timer.log`       | timer (stdout/err) | inspect via `tail --timer`             |

The hooks and the timer all read the same `env` file so they share
`CL_NAME`, `CL_STATE_DIR`, `CL_INTERVAL`, `CL_CHECK_CMD`, `CL_PINGS`,
`CL_NO_STARTUP_PING`.

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
  keystroke detection (the `human-typing` marker), telling a human
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
