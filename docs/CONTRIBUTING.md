# Contributing to aiball — agent + dev guide

Single entry point for **how we work on this codebase**. The audience is
both human contributors and the Claude agents that drive most of the
work (aiball-win on Windows, claude-aiball-dev on Linux, etc.).

The repo's [`README.md`](../README.md) tells you what aiball *is*; this
doc tells you how to *change* it. Operational instructions for the dev
checkout (the live runtime, frontend rebuild, hard restart for
migrations…) live in [`CLAUDE.md`](../CLAUDE.md) — load it first, then
come back here for the *how*.

## Sections

1. [Multi-agent norms](#1-multi-agent-norms) — how agents collaborate via aiball tickets
2. [Code style](#2-code-style) — language, commits, branches, migrations, tests
3. [Doc style](#3-doc-style) — reader-facing vs internal, refs policy, CHANGELOG flow
4. [Agent kit](#4-agent-kit) — what to preload, what to look up, what to remember

---

## 1. Multi-agent norms

aiball is built by a small fleet of Claude agents working in parallel
on a shared codebase. The norms below make sure two agents don't fight
over the same ticket, that handoffs survive context resets, and that
humans can read the audit trail tomorrow.

### 1.1 The aiball ticket IS the channel

Tickets are not a side-bar to the work — they are the work surface.

- **Decisions and rationale live on the thread**, not in a chat window
  that disappears at session end. If a decision shaped the code, the
  thread should explain why.
- **Status snapshots live in `summary_until`** on every reply (see
  [Brief reads + `summary_until`](#15-summary_until-state-not-action)
  below). A future agent who reads only the pivot snapshot + the
  latest body should be able to resume.
- **Inter-agent communication uses comments** (`ticket_reply`), not
  out-of-band messaging. The other agent sees it via their ping inbox,
  the human sees the same trail.

Conversation prompts from the human ARE valid inputs (the loop relays
them as wake messages), but anything the human decides via a ticket
comment is also authoritative — both feed the same agent.

### 1.2 Intents and priorities

`ticket_new` takes an `intent` that frames what's expected:

| Intent     | Meaning                                                      |
| ---------- | ------------------------------------------------------------ |
| `panic`    | Immediate blocker, drop other work                           |
| `request`  | Action expected (default)                                    |
| `question` | Needs an answer, not necessarily code                        |
| `fyi`      | Informational, no action expected                            |
| `feature`  | Isolated code work — branch + PR per [#319]                  |

Orthogonal to intent, `priority` (#B.222) is the urgency hint:
`urgent` / `high` / `normal` / `low`. Most tickets are `normal` — pick
the others deliberately. Priority influences `ticket_list` sort, ping
ordering, and the work-order returned by `ticket_engage`.

### 1.3 Claim discipline

A ticket can be **assigned** (durable ownership recorded on the row)
and/or **claimed** (live, recent intent-to-work signal — drops out of
other agents' actionable pool, see #418).

- **`ticket_engage`** is the canonical work-pick tool. It returns the
  head of *your* claimable queue and stamps a claim on it in one call.
  Use it instead of `ticket_list` when you're actually about to do
  something — `ticket_list` is the read-only exploration tool.
- **`no_claim` consumers** (set per-project via `.aiball.yaml`) get
  `engaged: null` and just listen — they comment / handoff but never
  claim. Useful for relay or observer agents.
- **Release the claim** when you're done with the actionable surface
  (PR open and awaiting review, or work shipped). Don't hold a claim
  across long idle waits — it blocks the work-order for everyone else.
  `ticket_release` is the explicit call.
- **Re-engaging** a ticket you already hold is idempotent — just
  refreshes the claim window.

### 1.4 Hot, own-claim, presence

Three independent signals on a ticket; understand the difference so
you don't conflate them:

- **`r.hot`** — cross-agent recency. Any agent's activity in the last
  ~10 min (`hot_window_sec`, configurable) bumps the ticket as hot for
  the visibility layer (the 🔥 indicator). Humans don't make tickets
  hot (#408). Recency only — a stale claim does not keep a ticket hot
  (#532).
- **own-claim** — your live claim on the ticket. Sorts above hot in
  the work-order (#430): explicit intent beats implicit recency.
- **`present`** — your loop is currently holding an SSE connection
  (the loop's process liveness signal, #395). Drives the running
  badge and unlocks live-only operations (e.g. inject prompt).

Hot is a *display + tiebreak* signal. Own-claim is a *coordination*
signal. Presence is a *liveness* signal. They don't replace each
other.

### 1.5 `summary_until`: state, not action

Every agent `ticket_reply` MUST carry `summary_until` (the API rejects
without it). This is **not** a recap of what you just did — it's the
**ticket state snapshot after this comment lands**, written so the
next agent (or you in a future session) can resume from just that
line.

Good (state-framed):

- `Awaiting david accept on PR #38 (timer resilience fix). CI green; no regressions noted in review.`
- `Phase B.2 shipped; next step is migration backfill on tokens.label.`

Bad (action-framed — describes what *you* did, belongs in the body):

- `Pushed PR #38 with the timer fix.`
- `Refactored everything as discussed.`

If a human reads only this single line plus the latest body, they
should know what's open and who owes what. Keep it sharp.

### 1.6 Handoffs

Three mechanisms, pick the right one:

- **`@-mention`** in a comment — soft handoff: the other agent gets a
  ping but the claim doesn't transfer. Use when you want a second
  opinion or to delegate a specific sub-task. Mention with their full
  consumer id (`@claude-aiball-dev`, `@aiball-win`).
- **`ticket_assign`** — formal ownership transfer. Use when the work
  legitimately belongs to a different agent (different host, different
  expertise). Releases any existing claim per #523.
- **`then: resolved` / `then: plan`** on the comment — proposes a
  decision. `resolved` = "I claim this is done, please accept." `plan`
  = "Here's HOW I'd tackle this, please validate before I execute."
  The reporter sees an accept/reject pair. Auto-accepted when the
  ticket is closed by the reporter.

Don't `@` an agent if you don't expect them to act — use a plain
comment. The ping notifications respect the mention semantics.

### 1.7 Sub-tickets vs comments

Open a sub-ticket (`ticket_new` with `parent_ticket_id`) when:

- The work has its own distinct deliverable (a separable PR, a
  separate review cycle).
- You want a separate `summary` line in the inbox.
- The scope is wide enough that mixing it into the parent thread
  would bury the existing discussion.

Stay in the parent thread when:

- The follow-up is atomic: one comment, one decision, done.
- The discussion is still converging on what to do.

A parent ticket's UI surfaces its sub-tickets list, so the linkage
stays visible.

### 1.8 Scope (`internal` / `default` / `broadcast`)

`scope` on `ticket_new` and `ticket_reply` controls fan-out (#B.245):

- `internal` — owners only + explicit `@`-mentions. Use for sensitive
  or owner-only coordination.
- `default` — ticket subscribers + project owners + mentions. The
  normal case for reply traffic (#253).
- `broadcast` — `default` + project followers. Use when the ticket
  surface is API-impacting or otherwise interests followers.

Each comment decides its own fan-out independently.

### 1.9 What lives in tickets vs code comments vs commit messages

Triage based on audience:

- **Ticket thread**: rationale, alternatives considered, who decided
  what, links to other tickets / PRs. Internal numbers (`#532`,
  hashids) are fine here.
- **Code comment**: WHY the code is non-obvious (a hidden invariant,
  a workaround for a specific bug). Reference a ticket only when the
  code itself can't tell the future reader the *why*. See
  [§ 2 Code style](#2-code-style) on comment policy.
- **Commit message + PR body**: WHY this change. Use ticket refs
  (`fix(#530 cerqc8): …`) — internal context is appropriate for
  release history. Reader-facing docs stay clean of these refs.

Deep dives on the lifecycle and event model live in
[`docs/TICKET_LIFECYCLE.md`](TICKET_LIFECYCLE.md).

---

## 2. Code style

_(coming next slice — see #541 plan)_

## 3. Doc style

_(coming next slice)_

## 4. Agent kit

_(coming next slice)_

[#319]: # "feature intent — branch + PR isolated work"
