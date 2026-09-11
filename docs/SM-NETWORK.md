# State Machine Network

The claude-loop runtime is composed of decentralized XState v5 actors,
one per concern. Each actor owns a slice of the shared `ipcState`,
exposes a typed API, and communicates with others by events — no shared
mutable state, no god component.

This doc is the **single source of truth** for the network. Per-machine
internals (states, events, context fields) live in the machine source
file's header — do not duplicate them here. Use this doc for the **map**
of which controller does what and how they wire together.

## Vision

- **One slice per controller** — a single owner of a coherent piece of
  the runtime state (boot phase, AFK mode, pane lifecycle, …). No two
  controllers write to the same ipcState field.
- **Pure machines** — every machine is declarative
  (`setup({...}).createMachine({...})`). No I/O inside. Side-effects are
  driven by external **pumps** (setInterval, event listeners, hooks).
- **Subscriber → ipcState bridge** — each actor has one subscriber that
  mirrors `actor.context` (and state matches) to ipcState fields. That's
  the ONLY path from a controller's context to the shared state.
- **Composition root in `kernel.ts`** — actors are instantiated, wired,
  and started in `mainSse`. Pumps + subscribers all live alongside.

## The purity contract — events are the only integration channel

**A machine never manipulates the outside world from inside.** Inside the
declared `actions`, the only allowed operations are :

- `assign({...})` — mutate `context`.
- `emit({type: "<controller>:<event_name>", ...})` — fire a typed locus event.
- Pure helpers (no I/O, no `Date.now()`, no global state reads/writes).

**Forbidden inside machine actions** :

- ❌ `setIpc<Field>(...)` writes — that's the SUBSCRIBER's job, in `kernel.ts`.
- ❌ `armAfkViaService` / `tryWake` / any helper that mutates the runtime — that's a CONSUMER's job, via `actor.on(...)`.
- ❌ `log(...)` inside emit actions — log in the consumer (where you have actor identity context), not in the action.
- ❌ `Date.now()` / `Math.random()` / file reads — would break testability and the resume-from-journal property of XState.
- ❌ `actor.send(...)` to itself or another actor — cross-controller signaling goes through `emit` + `actor.on`, not direct sends.

The actor's only outputs to the outside are the **snapshot** (via `subscribe`) and the **emitted events** (via `actor.on`). Outside code never reaches inside.

### Decision rule — when you need to add a behavior

Faced with a new requirement ("when AFK clears AND the user typed in the last second, do X"), apply this decision rule :

| Case | Approach |
|---|---|
| **The behavior is a reaction** to a transition that already exists | Wire a new consumer : `afkActor.on("afk:cleared", cb)` that runs the side-effect. The machine is untouched. |
| **The behavior changes the state structure** (new state, new transition, new guard, new context field) | Revise the SM declaratively : add the state / transition / guard, declare an emit if it's a new locus, write tests. |
| **The behavior is a side-effect inside the machine** | ❌ Wrong shape. Move it OUT to a consumer, or restructure as a state change + emit + consumer. |

The third case is the one to watch for : if you find yourself tempted to call `setIpcXxx` from a machine action, that's the signal that the integration boundary is being violated. Either the consumer needs a new emit to react to, or the state structure needs to change.

### Why this matters

- **Testability** : pure machines are unit-tested by sending events and asserting snapshots/emits, no mocks needed.
- **Replayability** : XState v5 supports persistence + replay of an actor from a journal. Side-effects inside actions would re-execute on replay.
- **Auditability** : grepping `emit({type:` gives the complete public surface of a controller. Side-effects scattered inside actions would hide that surface.
- **Local reasoning** : when changing a consumer, the consumer's logic is fully readable in one place (no fragments inside the machine).

## Network overview

```mermaid
graph LR
  Watchers[Pane scan] -- "MODULE_SEEN" --> Boot[BootMachine]
  Pump[bootDeadlineTimer] -- "DEADLINE_REACHED" --> Boot
  Boot -- "emit: boot:sealed / loop:start" --> Consumers[Consumers in kernel.ts]
  Hooks[Hooks: SessionStart / Stop / UserPromptSubmit] -- "SESSION_START / TURN_STARTED / TURN_ENDED" --> Turn[TurnController]
  Turn -- "emit: turn:settled" --> Consumers
  Consumers -- "BOOT_READY / REQUEST_WAKE / WAKE_*" --> Wake[WakeController]
  Proxy[PTY proxy keystrokes] -- "KEYSTROKE" --> Typing[TypingController]
  F9[F9 toggle / typing] -- "ARM_* / HARD_*" --> Afk[AfkController]
  AfkPump[afkExpiryTimer] -- "EXPIRY_REACHED" --> Afk
  Afk -- "emit: afk:armed_10m / armed_inf / cleared" --> Consumers
  Busy[Pane busy watcher] -- "BUSY_LATCHED / BUSY_CLEARED / TICKET_ACTIVITY" --> Sanity[SanityController]
  Sanity -- "emit: sanity:clear_paneBusy" --> Consumers
  Prompt[Pane scan] -- "PROMPT_DETECTED / PROMPT_CLEARED" --> Health[HealthCheckController]
  Boot -- "subscribe → bridge" --> Ipc[(ipcState)]
  Afk -- "subscribe → bridge" --> Ipc
  Wake -- "subscribe → bridge" --> Ipc
  Typing -- "subscribe → bridge" --> Ipc
  Turn -- "subscribe → bridge" --> Ipc
  Ipc --> BarRenderer
  Ipc --> WakeGate[Wake gate / isAfkActive]
```

## Controllers

### BootMachine — shipped

| Field | Value |
|---|---|
| **Source** | [`src/claude-loop/boot-machine.ts`](../src/claude-loop/boot-machine.ts) |
| **Role** | Owns the boot phase lifecycle. Single authority for sealing. |
| **Slice owned** | `ipcState.bootDeadlineMs`, `ipcState.bootComplete` |
| **Events in** | `MODULE_SEEN` { name, nowMs, remanenceMs } (pane scan, while a boot screen is visible), `DEADLINE_REACHED` (deadline pump) |
| **Events emitted** | `boot:sealed` { loopStartMs, reason: `"deadline"` } / `loop:start` { loopStartMs } |
| **States** | `booting` (initial) → `sealed.fresh` → `sealed.settled` (after 10 s, emits `loop:start`) |
| **Pump** | `bootDeadlineTimer` setInterval (1s) in `kernel.ts` |
| **Tests** | `boot-machine.test.ts` |

Each boot screen (the floor module, the resume picker, `/compact`…) stays live
for its remanence after it was last seen; the machine seals once every one has
gone. A respawn restores the persisted snapshot, already sealed. See the source
file header for the model.

### AfkController — shipped

| Field | Value |
|---|---|
| **Source** | [`src/claude-loop/afk-machine.ts`](../src/claude-loop/afk-machine.ts) |
| **Role** | F9 toggle cycle + typing-driven arm + timed expiry, with 3s debounce on display. |
| **Slice owned** | `ipcState.afkMode/afkExpiryMs` (committed) + `ipcState.dispAfkMode/dispAfkExpiryMs` (display) |
| **Events in** | `ARM_10M`/`ARM_INF`/`ARM_OFF` (debounced), `HARD_ARM_10M`/`HARD_ARM_INF`/`HARD_CLEAR` (immediate), `EXPIRY_REACHED` |
| **Events emitted** | `afk:armed_10m` { expiryMs, prevMode } / `afk:armed_inf` { prevMode } / `afk:cleared` { prevMode, reason: `"user"` \| `"expiry"` } |
| **States** | `off`, `pending_off`, `pending_10m`, `pending_inf`, `wait_10m`, `wait_inf` |
| **Pump** | `afkExpiryTimer` setInterval (1s) + `after(3000)` internal delays |
| **Tests** | `afk-machine.test.ts` |

Display/committed split is encoded via `pending_*` states with `after(3000)`
delayed transitions to the `wait_*` committed states. The single subscriber
mirrors `context.afkMode/afkExpiryMs` (committed) and projects the leaf
state name to `ipcState.dispAfkMode/dispAfkExpiryMs` (display).

### WakeController — shipped

| Field | Value |
|---|---|
| **Source** | [`src/claude-loop/wake-machine.ts`](../src/claude-loop/wake-machine.ts) |
| **Role** | Owns the wake lifecycle : in-flight mutex (replaces `tryWakeInFlight` Promise) + post-fire cooldown (= coalesce window). External gates (zen, idle-since, wakeAllowed, checkHasWork, drained-state, hasContent) stay in `tryWake` consumer. |
| **Slice owned** | `ipcState.wakeInFlightAtMs`, `lastWakeAtMs` |
| **Events in** | `BOOT_READY`, `REQUEST_WAKE` { source, atMs }, `WAKE_DELIVERED` { phrase, headMessageId, deliveredAtMs }, `WAKE_COMPLETED`, `WAKE_SKIPPED` |
| **Events emitted** | `wake:requested` { source, atMs } / `wake:in_flight_started` { atMs } / `wake:delivered` { phrase, headMessageId } / `wake:cleared` { reason: `"completed"` \| `"ttl"` \| `"skipped"` \| `"boot_gated"` } / `wake:cooldown_expired` |
| **States** | `gated` (initial) → `idle` → `inFlight` → `cooldown` → `idle`; `inFlight` → `idle` on `WAKE_SKIPPED` |
| **Pump** | None — XState `after(inFlightTtl)` (30 s) + `after(coalesceWindow)` (10 s) handle the lifecycle. |
| **Tests** | `wake-machine.test.ts` |

The machine starts `gated` and opens on `BOOT_READY` (sent on `loop:start`); a
`REQUEST_WAKE` before that is dropped with `wake:cleared(boot_gated)`. A
`REQUEST_WAKE` during `inFlight` or `cooldown` is dropped silently — consumers
gate with `wakeSvc.isIdle()` before sending. The `wake:delivered` consumer (in
`kernel.ts:mainSse`) calls `markMessageSeen` on the FIFO-head ack.

### TypingController — shipped

| Field | Value |
|---|---|
| **Source** | [`src/claude-loop/typing-machine.ts`](../src/claude-loop/typing-machine.ts) |
| **Role** | Tracks the human-typing signal — 2-state SM (`idle`/`hot`) with inactivity TTL. Fires `typing:started` once per burst and `typing:ended` after the TTL window. |
| **Slice owned** | `ipcState.humanTypingAtMs` |
| **Events in** | `KEYSTROKE` { atMs } (= from pty-proxy `touch_marker` events via `touchHumanTyping`) |
| **Events emitted** | `typing:started` { atMs } / `typing:ended` { lastKeystrokeMs } |
| **States** | `idle` → `hot` → `idle` (cycle, `after(ttlMs)` returns) |
| **Pump** | None — XState `after(ttlMs)` handles the idle return. |
| **Tests** | `typing-machine.test.ts` |

### TurnController — shipped

| Field | Value |
|---|---|
| **Source** | [`src/claude-loop/turn-machine.ts`](../src/claude-loop/turn-machine.ts) |
| **Role** | Tracks claude's turn lifecycle from the three hook events (SessionStart / Stop / UserPromptSubmit), and paces the wakes: `turn:settled` asks for one 10 s after a turn ended. |
| **Slice owned** | `ipcState.idleSinceMs` |
| **Events in** | `SESSION_START` { atMs }, `TURN_STARTED` { atMs }, `TURN_ENDED` { atMs } |
| **Events emitted** | `turn:no_turn_since` { atMs, reason: `"session_start"` \| `"turn_ended"` } / `turn:started` { atMs } / `turn:ended` { atMs } / `turn:settled` { idleSinceMs } |
| **States** | `unknown` → `no_turn` (`fresh` → `settled` after 10 s, emitting `turn:settled`) ⇄ `in_turn` |
| **Pump** | None — event-driven from the hooks, plus `after(10 s)` into `settled`. |
| **Tests** | `turn-machine.test.ts` |

### SanityController — shipped

| Field | Value |
|---|---|
| **Source** | [`src/claude-loop/sanity-machine.ts`](../src/claude-loop/sanity-machine.ts) |
| **Role** | Safety net for a stale `paneBusy` latch: busy stays set with no sign of activity (a lost Stop hook, a crash mid-turn). The normal path clears busy on `turn:ended`; this covers the abnormal one. |
| **Slice owned** | None — its consumer calls `setPaneBusy(false)`. |
| **Events in** | `BUSY_LATCHED` { atMs }, `BUSY_CLEARED` { atMs }, `TICKET_ACTIVITY` { atMs } (a wake delivered, a prompt submitted) |
| **Events emitted** | `sanity:clear_paneBusy` { reason: `"stale_timeout"`, atMs } |
| **States** | `unknown` → `watching` ⇄ `idle`; in `watching`, `after(STALE_BUSY_MS)` (5 min) emits the clear |
| **Pump** | None — XState `after`. |

### HealthCheckController — shipped

| Field | Value |
|---|---|
| **Source** | [`src/claude-loop/health-check-machine.ts`](../src/claude-loop/health-check-machine.ts) |
| **Role** | Tracks Claude Code's native session-health feedback prompt on screen. Logged only; nothing acts on it yet. |
| **Slice owned** | None. |
| **Events in** | `PROMPT_DETECTED` { atMs }, `PROMPT_CLEARED` { atMs } |
| **Events emitted** | `health:prompt_detected` { atMs } / `health:prompt_cleared` { atMs } |
| **States** | `idle` ⇄ `prompted` |
| **Pump** | None. |

### Future controllers (queued)

- **PaneStateController** — pane{Busy,Ready,Compacting,Resuming,Interrupted,Pickers} consolidation.

Each will follow the same pattern : pure machine, external pump (if needed), subscriber → ipcState bridge, `<controller>:<event_name>` emits.
## Patterns

### Composition root

All actors are instantiated and wired inside `mainSse` in `kernel.ts`. Order :

1. Pane watchers fire `change` events (`refreshPaneMarkers`).
2. Controller actors are created with seed input from `readLoopStateInput`.
3. Subscribers are wired BEFORE `actor.start()` so the initial snapshot fires through.
4. External pumps (deadline timer, expiry timer) are armed after start.

### Subscribe → ipcState bridge

The canonical pattern for mirroring `actor.context` onto the shared
`ipcState` — purely a **state mirror**, no side-effects beyond `setIpc*`
calls :

```ts
actor.subscribe((snap) => {
    // Mirror context fields the consumers read.
    setIpc<Field>(snap.context.<field>);
});
```

The subscriber runs synchronously on subscribe (initial snapshot) and on every transition or context change. Keep it small — reactions to specific transitions live in **locus event consumers** (see below).

### Locus events — `emit` + `actor.on`

Each controller declares its **locus events** (= pivotal transitions the rest of the network cares about) via XState v5 `emit(...)` in transition actions. Consumers subscribe with `actor.on(eventType, cb)` and receive a typed payload.

**Naming convention** : `<controller>:<event_name>` (snake_case after the colon). The prefix identifies the source controller ; consumers can filter by prefix (`event.type.startsWith("afk:")`).

| Controller | Locus events |
|---|---|
| `boot:` | `boot:sealed`, `loop:start` |
| `afk:` | `afk:armed_10m`, `afk:armed_inf`, `afk:cleared` |
| `wake:` | `wake:requested`, `wake:in_flight_started`, `wake:delivered`, `wake:cleared`, `wake:cooldown_expired` |
| `typing:` | `typing:started`, `typing:ended` |
| `turn:` | `turn:no_turn_since`, `turn:started`, `turn:ended`, `turn:settled` |
| `sanity:` | `sanity:clear_paneBusy` |
| `health:` | `health:prompt_detected`, `health:prompt_cleared` |
| `pane:` (planned) | `pane:busy_started`, `pane:idle`, `pane:compacting_started`, `pane:compacting_ended` |

**Payload guidelines** — what to put on the event vs what to leave for `subscribe(snap)` or `getSnapshot()` :

- ✅ **Timestamps** (`expiryMs`, `sinceMs`, `elapsedMs`, `loopStartMs`) — useful for decisions and metrics.
- ✅ **Previous state** (`prevMode`) — useful to discriminate transitions sharing the same target (e.g. `wait_10m → off` vs `wait_inf → off`).
- ✅ **Reason discriminator** (`reason: "user" | "expiry"`, `reason: "completed" | "ttl" | "skipped"`) — useful for logs and conditional consumer actions.
- ❌ **Full context snapshot** — defeats the purpose vs `subscribe(snap)`.
- ❌ **ipcState reads** — the consumer can read them itself if needed.

**Typed via `setup.types.emitted`** — the discriminated union forces TypeScript narrowing in consumers :

```ts
// In <controller>-machine.ts
setup({
    types: {
        emitted: {} as
            | { type: "afk:armed_10m"; expiryMs: number; prevMode: AfkMode }
            | { type: "afk:cleared"; prevMode: AfkMode; reason: "user" | "expiry" },
    },
    actions: {
        emitArmed10m: emit(({ context }) => ({
            type: "afk:armed_10m" as const,
            expiryMs: context.afkExpiryMs ?? 0,
            prevMode: context.afkMode,
        })),
    },
})

// In kernel.ts (or any consumer)
afkActor.on("afk:armed_10m", (ev) => {
    log(`armed 10m expiry=${new Date(ev.expiryMs).toISOString()} from ${ev.prevMode}`);
});
```

**Emit timing** — place emit actions **first** in the transition's `actions` array so they read `context.<field>` BEFORE the `assign` actions mutate it. Common pattern :

```ts
actions: ["emitX", "commitToTargetState"]  // emit reads OLD context, then assign mutates
```

### The inbound channel — `actor.send`

The inverse of `emit` (controller → outside) is `actor.send({...})` (outside → controller). It's the SOLE way for external code to drive the machine — declared events in, locus events out, no other public interface.

**Naming convention — distinguish direction at the callsite** :

| Direction | Channel | Declared in | Convention | Example |
|---|---|---|---|---|
| Outside → SM (drive) | `actor.send({type, ...})` | `setup.types.events` | `SCREAMING_SNAKE_CASE` | `REQUEST_WAKE`, `KEYSTROKE`, `SESSION_START`, `MODULE_SEEN` |
| SM → Outside (notify) | `emit({type, ...})` ↦ `actor.on(type, cb)` | `setup.types.emitted` | `<controller>:lower_snake` | `wake:requested`, `boot:sealed`, `afk:armed_10m` |

The two casings make the direction obvious : a `SCREAMING_CASE` event name in a call means "outside is telling the machine something happened" ; a `controller:lower_case` name means "the machine is telling outside something happened".

**Allowed inbound** :

- ✅ `actor.send({type: "EVENT_NAME", ...payload})` from any consumer (kernel.ts, hook subscribers, external services).
- ✅ Events declared in the machine's `setup.types.events` discriminated union — TypeScript narrows the payload at the send-site.
- ✅ A single keystroke / hook event may legitimately translate to a SCREAMING_CASE event (`KEYSTROKE`, `SESSION_START`).

**Forbidden inbound** :

- ❌ Reaching into `actor.context` / `actor.state` to mutate it (no `setActorContext`, no `actor.modify` — XState v5 doesn't expose them anyway, but the principle holds).
- ❌ Sending events that bypass the declared events union (TypeScript would catch it, but the rule is to keep the events surface FORMAL).
- ❌ A consumer that "knows the internal state" and sends events tailored to the current state. Inbound events describe **what happened in the outside world**, not what the machine should do next.

**When the inbound is "too thin"** :

If a consumer only ever sends an event that does `state→state'` with a single context assign and nothing else, that's the signal that the SM might not be earning its keep — it's a pure router. Real SMs do something *between* `actor.send` and the resulting `emit` (timer, debounce, guard, mutex, multi-state cascade). See `PaneStateController` post-mortem in the ticket thread for an example of an SM that didn't pass this test.

### External pump

Machines stay **pure** — no internal timers, no `Date.now()`, no I/O. The
wrapper in `kernel.ts` is responsible for :

- Polling `actor.getSnapshot()` and firing synthetic events (e.g.
  `DEADLINE_REACHED` when the wall clock passes `context.deadlineMs`).
- Forwarding external signals (watcher events, hooks, IPC) as
  `actor.send({...})` calls.

This keeps the machine fully testable in isolation (synthetic events, no
wall-clock dependency) while the wrapper integrates with the real runtime.

### Respawn handoff

When the kernel re-execs in place (source SHA changed, see `selfReloadIfStale`),
some ipcState is preserved across the spawn (e.g. `bootComplete=true`,
`afkMode/Expiry`). The BootMachine restores its persisted snapshot, already
sealed; the AfkController is synchronised to the live ipcState via its `ARM_*`
events. The subscriber detects "already committed" via the ipcState gate and
skips fresh-seal side-effects.

## Adding a new controller

1. Write `<name>-machine.ts` with `setup({...}).createMachine({...})`.
   Pure, no I/O, no `Date.now()`/`Math.random()`. Header comment carries
   the state diagram + event table. Declare `setup.types.emitted` with
   the discriminated union of `<name>:<event_name>` locus events + their
   payloads. **Respect the purity contract** (above) — actions only
   `assign` + `emit`, never reach outside.
2. Write `<name>-machine.test.ts` covering every transition, every guard,
   and every emit (`actor.on("<name>:<event_name>", cb)` + assert payload).
3. In `kernel.ts:mainSse` :
   - `const actor = createActor(machine, {input: ...});`
   - `actor.subscribe(snap => bridge snap.context → ipcState)` (state mirror only).
   - `actor.on("<name>:<event_name>", ev => ...)` for each locus event reaction.
   - `actor.start()`.
   - Arm any external pump (e.g. `setInterval` polling `getSnapshot()`).
4. Drop the legacy code path that this controller replaces. Don't leave
   parallel writers — the new controller is the sole owner of its slice.
5. Add a section in this doc (Controllers list above) — single-source the
   role + slice + events in + emits. Don't duplicate the state diagram
   (that lives in the source file header).

## Tradeoffs and choices

### Why XState v5 and not a hand-rolled SM ?

- Declarative `setup({...}).createMachine({...})` — the state diagram is
  the source. Less drift between code and intent.
- Built-in `after`, `guard`, parallel states, `assign` — primitives we'd
  otherwise reinvent piecemeal.
- Subscriber/observable API mirrors what we already do with `loopBus` —
  drop-in for the bridge pattern.
- Tests are pure event sequences against `createActor(machine).send(...)`.

### Why one actor per concern, not one big machine ?

- Loose coupling : a controller can be replaced or tested in isolation.
- Single ownership per slice avoids cross-controller race conditions.
- Composition root in `kernel.ts` is explicit — no surprising wiring.

### Why XState `after(N)` instead of an external `setTimeout` ?

Internal `after(N)` keeps the timing semantics inside the machine = the
state diagram tells the full story. Equivalent external `setTimeout`
would scatter timing across the wrapper, breaking the "machine = spec"
invariant.

### Why both `subscribe` AND `emit` ?

The two patterns serve different needs and complement each other :

- **`subscribe(snap)`** = continuous **state mirror**. Fires on every snapshot
  change, even mid-transition context updates. Used exclusively to bridge
  `actor.context.<field>` onto `ipcState`.
- **`emit({type: ..., ...})`** + **`actor.on(event, cb)`** = discrete **locus
  events** at specific transitions, with typed payloads. Used for everything
  reactive : log lines, side-effects, cross-controller signaling.

Splitting them keeps each subscriber small and intent-revealing : the
`subscribe` block reads as "what does ipcState mirror", the `actor.on`
blocks read as "what happens on this specific transition".

A controller's transitions can fire BOTH a context update (caught by
`subscribe`) AND an `emit` (caught by `actor.on`) — they're independent
channels.

### Why a typed locus vocabulary (`<controller>:<event_name>`) ?

The prefix scopes ownership : a `wake:requested` event is unambiguously
emitted by the WakeController. Consumers can filter by prefix
(`event.type.startsWith("afk:")`) when they want all events from one source.

The discriminated union via `setup.types.emitted` gives the consumer
TypeScript narrowing for free — `actor.on("afk:armed_10m", ev)` sees
`ev.expiryMs` as `number`, not as `unknown` or `string | undefined`.

## The kernel event bus

The locus-event vocabulary above (`<controller>:<event_name>`) is decentralised:
to react to a signal you must know which actor (or which non-actor source —
`WakeBus`, the `loop.sock` server, the pane watchers) carries it. The **kernel
bus** (`kernel-bus.ts`, `getKernelBus()`) is a single typed aggregation surface
over all of them, so a consumer subscribes in one place:

```ts
getKernelBus().on("turn:settled", ({ idleSinceMs }) => { … });
getKernelBus().on("ipc:disconnect", ({ peer }) => { … });
```

### Where it sits

The bus is the **consumer / transport layer — OUTSIDE the purity boundary**. It
is a plain typed `EventEmitter`-like store, NOT an XState actor, and it is
**never imported inside a machine action** (machines still only `assign` +
`emit`). The composition root forwards the actors' emits onto it; it never
reaches back into a machine.

### Producers (additive — they run alongside the existing wiring)

- **In-process actor emits** → `bridgeActorToKernel(actor, types)` in the
  composition root forwards every `<controller>:<event>` emit onto the bus, next
  to the business `actor.on(...)` consumers. The actor stays the sole emitter.
- **Cross-process sources** are adapted into the same catalogue: `WakeBus`
  hello/ping/control → `daemon:*`; the `loop.sock` proxy connect / disconnect /
  resync → `ipc:*`; the `LoopStateBus` transition → `pane:changed`; the counter
  refresh → `counters:refreshed`.

The full catalogue is the `KernelEventMap` type in `kernel-bus.ts`.

### Convergence rule (no big-bang)

The bus is **additive**. The decentralised channels it aggregates —
`actor.on(...)` and the coarse `onIpcChanged` notifier in `ipc-state.ts` —
**coexist** with it; the bus does not replace them. New consumers should prefer
`getKernelBus().on(...)`; existing ad-hoc subscriptions migrate
**opportunistically** (rename what you touch when you edit nearby code, don't
run a dedicated sweep — same posture as the `timer → kernel` naming migration).

## See also

- [`CLAUDE-LOOP.md`](./CLAUDE-LOOP.md) — claude-loop wrapper overview (uses the network).
- [XState v5 docs](https://stately.ai/docs) — primitives reference.
