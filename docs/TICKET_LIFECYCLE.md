# Ticket lifecycle & the `actionable` model

> **Status: IMPLEMENTED.** The `last_actor` model below is live: the
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
[work order](#5-the-work-order) orders whatever's left.

> **Invariant — always surface the `open` count.** `actionable` can be
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

## 3. Decisions on comments

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
  (a task C logged for itself, no counterpart) → stays actionable. *(`last_actor`
  alone is **not** enough — without this clause an agent's own un-answered task
  tickets vanish from its queue.)*
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

One signal collapses several special cases (the lastAuthor + decision-gate
cases):

- agent posts a pending plan/resolution → agent is last_actor, counterpart
  exists → **gated** (= old "pending proposal awaiting human").
- david comments after a pending proposal → david is last_actor → **un-gated**
  (= the recency rule, for free).
- david accepts a plan → david is last_actor → **re-actionable** (= the
  go-signal, for free).
- david reopens → david is last_actor → **re-actionable** (= **reopen fixed**).
- david accepts a resolution → ticket closes → leaves the open set.

### 4.4 Gates that stay separate from `last_actor`

- **blocked** (`ticket_blocked`) — suppressed until unblocked.
- **relation gate** — an open `depends_on` / `blocks` blocker
  suppresses the dependent.
- **hold gate** (`isHeldByOther`) — a hold by *someone other than C* drops the
  ticket from C's pool (anti-collision). See §4.5.
- **snoozed / closed / non-approved** — not open in the first place.

### 4.5 Assignment vs claim — the two holds (#436 / #439)

Two distinct holds, both anti-collision, split from one fused field:

- **Assignment** (`assignee` / `assigned_by` / `assigned_at`) — a *responsibility*
  a human/moderator **pushes** onto a consumer via the web UI. **Persistent**
  (no expiry). Human-only — agents have no MCP path to assign to a third party.
- **Claim** (`claimant` / `claimed_at`) — a *focus* an agent **self-declares**
  ("I'm on this now"), via `ticket_claim` (zero-arg picks the work-order head;
  with `ticket_id` claims that specific ticket).
  **Transient**: the live window is derived (`now − claimed_at < assign_window_sec`).

A ticket can be **both** at once. The **hold gate** (`isHeldByOther`,
`src/db/assignment-gate.ts`) drops a ticket from C's actionable pool when it is
held by **someone other than C** — a *live* claim by another agent **OR** an
*assignment* to another consumer. Held-by-C, unheld, or an *expired* claim with
no assignment → not gated (falls through to `last_actor`). Both holds clear on
close/resolve (`releaseTicketHold`).

- **One focus at a time (#439).** A self-claim auto-releases C's *other* **live**
  claims that are *bare pickups* — claims C never commented on (zero work lost).
  Claims C actually worked survive: posting an approved comment **auto-claims**
  the ticket (#418), so a worked ticket's `claimed_at` *equals* C's latest comment
  (`lastMs >= claimedMs`), whereas a bare pickup-claim's `claimed_at` is strictly
  after any earlier comment → released. The ticket just claimed is never dropped
  (re-claim stays idempotent). Stops an agent stacking locks that each drop a
  ticket from every other agent's pool. (`claimsToAutoRelease`, pure + tested;
  wired in `POST /tickets/:id/assign`, surfaced as `released_claims`, relayed by
  `ticket_claim`.)
- **Token attribution (#439).** A turn's token-usage is attributed to C's
  **most-recently-claimed live** claim (the durable focus), falling back to the
  volatile `active-ticket` marker only when C holds no live claim — so an
  incidental ticket-scoped write mid-turn no longer mis-attributes the turn.
  (`pickFocusClaim`, server-side re-anchor in `POST /tickets/:id/token-usage`.)
- **Work-order tiebreak.** C's own live **claim** sorts **above the hot-zone**
  (explicit focus outlasts the decaying hot window); an **assignment-to-C** is a
  separate, weaker boost below own-claim. See §5.

---

## 5. The work order

`ticket_list` returns a **work landscape**: tiered, then ordered within a tier.
The keys, outer→inner (pure comparator in `src/db/work-order.ts`):

1. **Tier** (greedy — each ticket in the highest tier it qualifies for):
   `unread` → `actionable` (¬unread) → other open → the rest (closed/snoozed).
2. **Priority** desc (urgent→low) — the **strongest** sort within a tier
   (david `xkehmv`: « priorité est le tri le plus fort »). Explicit priority wins.
3. **Own live claim** (#430) — at **equal priority**, a ticket the consumer holds
   a live claim on (its explicit focus, see §4.5) sorts first, **above** hot — the
   claim is the durable "what I'm on" signal where hot decays. Within-tier only.
4. **Assigned-to-you** (#436) — a ticket a human handed the consumer; a weaker
   boost, below own-claim, above hot. Within-tier only.
5. **Hot** (levier 1) — at equal priority + no claim/assignment distinction, a
   ticket in the requesting consumer's **hot-zone** sorts first (see §5.1).
6. **Oldest-first** (id asc) — final tiebreak.

The wake-CTA **names the head** of this order (`#{head_id}`) so the agent takes
the top of its queue, not the newest/loudest. ("FIFO" is a misnomer — it's the
GET's work order.) It also **always states the open count** (per the §1
invariant) — even when `actionable` is empty — so a gated backlog is never
silent.

### 5.0 The backlog wake — two tiers of triage

When the unread FIFO is empty but there is at least one ticket worth surfacing,
the loop fires a **backlog wake** (`look #N: TITLE. Triage the ticket.`). The
ticket #N is the head of the backlog set, **split in two tiers**:

1. **Tier 1 — ball in my court.** Tickets where the last actor on the thread is
   someone other than me (reporter / counterpart / human). These match the
   `actionable` lens of §4.1: the wake fires on them first because the next move
   is mine.
2. **Tier 2 — ball already in their court.** Tickets where I was the last actor.
   I commented, the ball is with the reporter, and the thread is waiting on
   them. These stay in the backlog as a soft reminder set, sorted **below** tier 1.

A triage comment (§ in `skill/SKILL.md` → "`look #N: TITLE. Triage the ticket.`")
moves the ticket **from tier 1 to tier 2** within the same backlog — the agent
becomes the last actor, so the wake stops pointing at it as long as a tier-1
ticket exists. Concrete tickets only drop OUT of the backlog on a lifecycle
decision (close by the agent via `ticket_close`, snooze by the human via the
web UI) or when the reporter replies (which re-promotes the ticket to tier 1
because they're now the last actor → next wake names it again).

This formalises the soft rotation david called out: a simple comment doesn't
"remove" a ticket from the backlog (close or snooze does), but it pushes
the ticket to the end so the next wake picks the next head.

**Why two tiers, not "drop tier 2 entirely":** a ball-in-their-court ticket
isn't done — it's waiting on a human/reporter who may go silent. Surfacing it
in the wake (lower priority than tier 1) keeps it visible to the agent: a
periodic "look #N — still waiting on them" reminder, useful for nudging the
reporter or for the agent to decide it's stale enough to close itself.

**Within a tier**, the work-order keys from §5 apply: priority desc → own
claim → assignment → hot → id asc.

**API**: the daemon exposes the two-tier set via `GET /api/tickets?backlog=1`.
Tickets neither in tier 1 nor in tier 2 (= other people's open work) are
filtered out server-side; the work-order tiering keeps tier 1 first. The
loop's `buildContextPhrase` uses this filter for the FIFO-empty fallback.

### 5.1 The hot-zone

The hot-zone keeps the wake on **the conversation the agent is actively
working**, instead of jumping it to a stale oldest head whenever someone else
moves another ticket.

- **Definition (POV agent, david `xkehmv`):** a ticket is *hot* iff an
  **agent (non-human consumer)** has activity on it within the **hot window** —
  i.e. `now − max(created_at of messages authored by a non-`human`-kind consumer
  on the ticket) < hot_window_sec`. It is the **agent's focus**, an objective
  property of the ticket — **the same flag is shown to everyone**, including human
  viewers (who see *what the agent is on*, not their own activity). A **human**
  acting never makes a ticket hot:
  - agent works ticket A, **david** comments on ticket B → B is **not** hot
    (david is human → excluded; the agent stays on A);
  - david comments on the agent's ticket A → A **stays** hot (the agent's
    activity defines it; the human's comment is ignored);
  - david replies on a ticket **no agent has touched** → **not** hot
    ("c'est pas moi qui dois passer un ticket en hot" — his own reply must not
    flag it; the 🔥 follows the agent, not the viewer).
  - **Why agent-activity, not per-requester:** the first cut computed it
    over the *requesting* consumer's own activity, so when david viewed/commented
    in the UI his activity flagged his own ticket hot — wrong.
- **Window:** `hot_window_sec`, read from the **global config yaml**
  (`~/.config/aiball/config.yaml` → `hot_window_sec:`), **default 600** (10 min).
  (david `xkehmv` D2: yaml only, not a settings-table row.)
- **Scope:** hot is a **tiebreak at equal priority, within the tier** — it never
  promotes a ticket across `unread`/`actionable`/`open`, and never resurfaces a
  closed one.
- **Signal:** `ticketAgentLastActivity(ids)` = `MAX(created_at) GROUP BY
  ticket WHERE by_agent NOT IN (consumers WHERE kind = 'human')`. (Replaces the
  per-requester `ticketSelfLastActivity` used in the first cut.)

This is **levier 1 — ordering** (when the agent *is* woken, it points at the
right ticket). **Levier 2 — gating** (using the same hot-zone signal to *defer
the wake itself* for out-of-zone activity, so the agent isn't interrupted at all)
is a **second pass** (david `s62yaq`), tracked separately — with urgent/`@mention`
+ human-presence escapes so the agent never becomes unreachable.

---

## 6. Worked examples

| ticket | last action | actionable for the agent? |
|---|---|---|
| david files a bug, no reply | david created | ✅ last_actor=david ≠ agent |
| agent replied, awaiting david | agent comment | ❌ agent last, david is counterpart |
| david **reopens** ("encore vu ce bug") | david reopen | ✅ last_actor=david |
| david **accepts** the agent's plan | david decide | ✅ last_actor=david (go-signal) |
| agent logged an e2e task for itself, untouched | agent created | ✅ sole participant = agent's backlog |
| david accepts a resolution | david decide → close | ➖ closed, leaves open set |

---

## 7. Current vs target — the fix checklist

Today the whose-court gate is `lastNonLifecycleAuthorByTicket()`
(`src/db/projects.ts:872`), which counts **only `comment_added`** events (+ the
original author). Consequences:

- **Reopen** — a `ticket_reopened` is a lifecycle event → ignored → the agent's
  old comment stays "last author" → reopened bug **invisible** to the agent.
- **decide** (accept/reject) **mutates the comment meta in place, emits no
  event** (`applyMessageDecision`, `src/db/messages.ts:1087`) → david accepting
  doesn't register as his action. Plan-accept only "works" because the frontend
  posts the typed body as an artefact `comment_added` by david
  (`frontend/src/lib/resolutionFlow.ts:245`); resolution-accept (→`ticket_closed`,
  l.249) and reopen (→`ticket_reopened`, l.315) route their body onto lifecycle
  events → no flip.
- **Self-authored backlog** — the agent's own un-answered task tickets
  read `last_author = agent` → gated out (the §4.1 sole-participant clause is the
  fix; note `last_actor` alone does **not** cover this).

**Landed** (the `last_actor` column variant — `decide` keeps mutating
meta in place rather than emitting a `decided` event):

1. ✅ Stored **`last_actor` / `last_actor_at`** on the ticket — migration 0027,
   backfilled idempotently at boot (`460ca45`).
2. ✅ **Bumped on every action** — `bumpLastActor` at `insertMessage`
   (create + comment/lifecycle) and `applyMessageDecision` (decider) (`460ca45`).
3. ✅ The §4.1 rule (whose-court **+** sole-participant) — `lastActorExclusions`
   (`a12ec65`).
4. ✅ `computeActionableTicketIds` switched onto it; `lastNonLifecycleAuthorByTicket`
   retired; decision-gate folded in, relation/blocked kept (`a12ec65`).
5. ✅ Migration + one-time backfill (replays `decided_by`) (`460ca45`).
6. ✅ The §1 open-count invariant in the wake (`buildContextPhrase`) — open and
   actionable stated distinctly (`3e709a3`).

Validated live: the actionable pool went 1 → 12 (reopened bug + the
self-authored e2e backlog surfaced; dialogue tickets stay gated). Pure unit
tests cover the decision-gate and the last-actor exclusion rule.

**Related:** per-consumer actionable, latest-decision gate, decision-pending
gate + recency, reopened bug invisible, self-authored backlog, work order.
