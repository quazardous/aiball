# Ticket lifecycle & the `actionable` model

> **Status: IMPLEMENTED (#374).** The `last_actor` model below is live: the
> denormalized column + backfill (migration 0027), `bumpLastActor` at every
> action chokepoint, the §4.1 gate (`last_actor` + sole-participant) in
> `computeActionableTicketIds`, and the §1 open-count invariant in the wake.
> §7 records the original gap and the landed fix for history.

aiball is **event-sourced**: a ticket is a row, and everything that happens to
it is an append-only message/event. The ticket's "state" (open, resolved,
closed, …) and the per-consumer `actionable` verdict are *replays* of those
events. This doc defines the events, the states, and — the heart of it — how we
decide **whose court the ball is in**.

---

## 1. The three nested lenses

Per **consumer** (each agent/human sees its own slice). Smallest ⊂ largest:

```
unread  ⊂  actionable  ⊂  open
```

- **open** — not closed, not snoozed, moderation-approved. "Still alive."
- **actionable** — open **and in *your* court** (the gates in §4). The candidate
  pool the wake-CTA / work-order points you at.
- **unread** — actionable **and** ≥1 unseen ping for you. "Loud right now."

`ticket_list({open})` / `({actionable})` just subset to a lens; the
[work order](#5-the-work-order-371) orders whatever's left.

> **Invariant — always surface the `open` count (#374).** `actionable` can be
> small or empty (everything gated), but that must **never** read as "nothing to
> do." Any status surface — the wake-CTA, the sidebar badges, an agent's
> self-report — always states **how many tickets are open**, alongside the
> actionable count. The open count is the floor that keeps a gated backlog
> visible.

---

## 2. States & the events that drive them

**Moderation status** (orthogonal): `pending` → `approved` / `rejected`.
Only `approved` tickets are ever open/actionable.

**Lifecycle** (replayed from events, id-ascending = chronological):

| state | meaning | entered by |
|---|---|---|
| open | the default live state | `ticket_created` |
| resolved (pending close) | agent proposes it's done; reporter confirms | accepted `resolution` decision |
| closed | terminal (resolved / wontfix / dup) | `ticket_closed` |
| reopened → open | closed ticket brought back | `ticket_reopened` |
| snoozed | hidden from open until `postponed_until` | snooze (postponed_until in the future) |
| blocked | suppressed until unblocked | `ticket_blocked` |

**Event kinds** (the append-only log):
`ticket_created`, `comment_added`, `ticket_resolved`, `ticket_closed`,
`ticket_reopened`, `ticket_blocked`, `ticket_relation`, `ticket_sub_added`,
`ticket_referenced`.

---

## 3. Decisions on comments (#B.129 / #B.243)

A `comment_added` can carry a decision sidecar in its meta:

```jsonc
meta.decision = { kind: "plan" | "resolution", status: "pending" | "accepted" | "rejected" }
```

- **resolution** — "done, I propose to close." Accepted → ticket closes.
- **plan** — "here's HOW I'll tackle it, validate the approach." Accepted = a
  **go-signal**: the ticket re-enters actionable so the agent executes.
- A **pending** decision means *the reporter owes the next move* (accept/reject).
- accept/reject goes through `POST /messages/:id/decide`.

---

## 4. The `actionable` gate — TARGET

> A ticket is **actionable for consumer C** iff it is **open** AND **none** of
> the gates below exclude it.

### 4.1 Whose-court gate — driven by `last_actor`

The single signal: **`last_actor`** = the consumer who took the **last action**
on the ticket. The ball is in C's court unless C is the one who acted last *and
is waiting on a counterpart*.

```
actionable-for-C (whose-court) =
    last_actor ≠ C                      # someone else moved → my turn
    OR  C is the sole participant       # my own task, nobody to wait on → my turn
```

- **last_actor ≠ C** → C's turn (e.g. david commented / accepted / reopened).
- **last_actor = C but C is the sole participant** → it's C's own backlog
  (a task C logged for itself, no counterpart) → stays actionable. *(This is the
  #370/#374 case: `last_actor` alone is **not** enough — without this clause an
  agent's own un-answered task tickets vanish from its queue.)*
- **last_actor = C and a counterpart exists** → C acted last toward someone else
  → gated (awaiting them). *(e.g. agent posted a plan/reply, awaiting david.)*

### 4.2 What counts as an "action" (what sets `last_actor`)

| action | actor | event today |
|---|---|---|
| post a comment | the author | `comment_added` |
| accept / reject a decision | the **decider** | *(mutates meta — no event, see §7)* |
| resolve / close / reopen / block | the human who did it | `ticket_*` lifecycle |

**Not** an action: **auto-moderation** (`decided_by = "auto"`). An auto-approved
agent comment's actor is its **author**, not "auto".

### 4.3 Why `last_actor` unifies today's scattered gates

One signal collapses several special cases (#265 lastAuthor + #273/#358
decision-gate):

- agent posts a pending plan/resolution → agent is last_actor, counterpart
  exists → **gated** (= old "pending proposal awaiting human").
- david comments after a pending proposal → david is last_actor → **un-gated**
  (= the #358 recency rule, for free).
- david accepts a plan → david is last_actor → **re-actionable** (= the
  go-signal, for free).
- david reopens → david is last_actor → **re-actionable** (= **#305 fixed**).
- david accepts a resolution → ticket closes → leaves the open set.

### 4.4 Gates that stay separate from `last_actor`

- **blocked** (`ticket_blocked`) — suppressed until unblocked.
- **relation gate** (#B.123) — an open `depends_on` / `blocks` blocker
  suppresses the dependent.
- **snoozed / closed / non-approved** — not open in the first place.

---

## 5. The work order (#371)

`ticket_list` returns a **work landscape**: tiered, then ordered within a tier.

1. **Tier** (greedy — each ticket in the highest tier it qualifies for):
   `unread` → `actionable` (¬unread) → other open → the rest (closed/snoozed).
2. **Within a tier**: priority desc (urgent→low), then **oldest-first** (id asc)
   as a tiebreak. Explicit priority still wins.

The wake-CTA **names the head** of this order (`#{head_id}`) so the agent takes
the top of its queue, not the newest/loudest. ("FIFO" is a misnomer — it's the
GET's work order.) It also **always states the open count** (per the §1
invariant) — even when `actionable` is empty — so a gated backlog is never
silent.

---

## 6. Worked examples

| ticket | last action | actionable for the agent? |
|---|---|---|
| david files a bug, no reply | david created | ✅ last_actor=david ≠ agent |
| agent replied, awaiting david | agent comment | ❌ agent last, david is counterpart |
| david **reopens** ("encore vu ce bug") | david reopen | ✅ last_actor=david (**#305**) |
| david **accepts** the agent's plan | david decide | ✅ last_actor=david (go-signal) |
| agent logged an e2e task for itself, untouched | agent created | ✅ sole participant = agent's backlog (**#370**) |
| david accepts a resolution | david decide → close | ➖ closed, leaves open set |

---

## 7. Current vs target — the fix checklist

Today the whose-court gate is `lastNonLifecycleAuthorByTicket()`
(`src/db/projects.ts:872`), which counts **only `comment_added`** events (+ the
original author). Consequences:

- **#305** — a `ticket_reopened` is a lifecycle event → ignored → the agent's
  old comment stays "last author" → reopened bug **invisible** to the agent.
- **decide** (accept/reject) **mutates the comment meta in place, emits no
  event** (`applyMessageDecision`, `src/db/messages.ts:1087`) → david accepting
  doesn't register as his action. Plan-accept only "works" because the frontend
  posts the typed body as an artefact `comment_added` by david
  (`frontend/src/lib/resolutionFlow.ts:245`); resolution-accept (→`ticket_closed`,
  l.249) and reopen (→`ticket_reopened`, l.315) route their body onto lifecycle
  events → no flip.
- **#370 / self-authored backlog** — the agent's own un-answered task tickets
  read `last_author = agent` → gated out (the §4.1 sole-participant clause is the
  fix; note `last_actor` alone does **not** cover this).

**Landed** (#374, the `last_actor` column variant — `decide` keeps mutating
meta in place rather than emitting a `decided` event):

1. ✅ Stored **`last_actor` / `last_actor_at`** on the ticket — migration 0027,
   backfilled idempotently at boot (`460ca45`).
2. ✅ **Bumped on every action** — `bumpLastActor` at `insertMessage`
   (create + comment/lifecycle) and `applyMessageDecision` (decider) (`460ca45`).
3. ✅ The §4.1 rule (whose-court **+** sole-participant) — `lastActorExclusions`
   (`a12ec65`).
4. ✅ `computeActionableTicketIds` switched onto it; `lastNonLifecycleAuthorByTicket`
   retired; decision-gate (#273/#358) folded in, relation/blocked kept (`a12ec65`).
5. ✅ Migration + one-time backfill (replays `decided_by`) (`460ca45`).
6. ✅ The §1 open-count invariant in the wake (`buildContextPhrase`) — open and
   actionable stated distinctly (`3e709a3`).

Validated live: the actionable pool went 1 → 12 (#305 reopened bug + the
self-authored e2e backlog surfaced; dialogue tickets stay gated). Pure unit
tests cover the decision-gate (#358) and the last-actor exclusion rule.

**Related:** #265 (per-consumer actionable), #273 (latest-decision gate), #358
(decision-pending gate + recency), #305 (reopened bug invisible), #370/#374
(self-authored backlog), #371 (work order).
