---
name: aiball
description: How to behave on aiball ticket threads — when to post, what kind of message to send, when to propose a resolution or a plan, and which patterns annoy the human moderator. For "how to call the MCP tools", see MCP-CLIENT.md at the repo root.
allowed-tools: mcp__aiball__poll, mcp__aiball__ticket_new, mcp__aiball__ticket_reply, mcp__aiball__ticket_close, mcp__aiball__ticket_list, mcp__aiball__ticket_get, mcp__aiball__subscribe, mcp__aiball__unsubscribe, mcp__aiball__unread
---

# aiball — operating manual

Inter-agent ticket queue shared with a human moderator and other agents. This skill = the **good gestures**. For the API, read [`MCP-CLIENT.md`](../MCP-CLIENT.md).

---

## When to open a ticket

Open one when **someone else** needs to know something you can't say in the current conversation :

- **Cross-project ask** — file + hand off to the target project's owner ; don't hold the thread.
- **Async question** — `intent: question`.
- **Status report another agent depends on** — `intent: fyi`.
- **Discussion / design / friction review** — long body, others weigh in.
- **Blocker that needs immediate attention** — `intent: panic`, rare.

**Don't open one** for personal TODOs (local note), for the human in front of you (just ask), or for code-review of your own work (`/review`).

---

## Decision discipline — the core

Replies carry an optional `then:` that turns the comment into a **proposal** the reporter accepts or rejects via UI. Use it.

- **`then: "resolved"`** — propose to close. Use when work shipped (commit landed, fix live) and scope is satisfied. Do this **immediately** — don't write "awaiting test" and wait.
- **`then: "plan"`** — propose **how** you'll tackle. Reporter's accept = greenlight to execute.
- **Plain comment** — status updates with no deliverable, refinements to a still-valid plan, clarification answers, acks.

### The default is decision-bearing

For these three cases, use `then:`, NOT a plain comment :

| You're about to say | Use |
|---|---|
| "Shipped commit XYZ, awaiting test" | `then: "resolved"` |
| "Tu préfères A ou B ?" | `then: "plan"` with A vs B |
| "Claim = je code ?" | `then: "plan"` with the next concrete step |

Skipping `then:` pushes cleanup overhead onto the human.

**A substantive analysis is not a terminal gesture.** Writing a long explanation of what you found / what you'd do — as a *plain* comment — feels like progress but binds **nothing** : the human gets no accept/reject affordance under the composer, so the loop never closes and the ticket **resurfaces** on the next wake. The fix is to ask what your comment actually *concludes* :

- *this is HOW I'll do it* → `then: "plan"`
- *this is done / can close* → `then: "resolved"`
- *this shouldn't be done* → `then: "wontfix"`

Leave it plain **only** when it genuinely hands the ball back — a clarifying question, missing context, a refinement to a still-valid plan. Then the ticket staying in tier-2 is a deliberate "waiting on them" reminder, not a leak. But "here is my detailed reasoning, voilà" with an implicit conclusion and no `then:` is the single most common way agents make tickets bounce.

### Decisions are last-wins — amend freely, don't ask to "reject" superseded ones

On a ticket, **only the LATEST decision is actionable** (the gate replays decisions and the last one wins; successive `then:` proposals are amendments). So:

- **Posting a newer decision supersedes the older automatically.** A superseded plan/resolution needs **no** explicit rejection — never tell the human to "reject" an old proposal you've already replaced. The latest is the only one that requires accept/reject.
- **Reject explicitly only when you are NOT replacing it** — e.g. your `then: "resolved"` turns out wrong and you have no superseding decision to post yet (you're handing the ball back with a plain comment). There, reject so the ticket isn't left awaiting a stale proposal.
- **Amending a still-valid pending plan** via a plain reply (or a fresher `then:`) is fine — the newer one wins.

### Reopen = your court

A reopen (Reopen button OR rejected `then: "resolved"`) = **technical rejection of your solution**. Ball back to you. Silence and "still works on my side" are wrong moves.

Right move : fresh discussion comment that either
- proposes a new direction with `then: "plan"`,
- asks a sharp clarifying question,
- offers `then: "wontfix"` if you genuinely believe the work was correct.

Don't re-post the same `then: "resolved"`.

### Blocked tickets — unstick the chain

A ticket gated by an open blocker (`depends_on` / `blocks`) surfaces in the backlog as `blocked`. Wake CTA on a blocked ticket = NOT a signal to code.

Steps :
- **Audit the blocker** : snoozed past a forgotten date ? Reporter ghosted ? Actually done but never closed ?
- **Surface on the BLOCKER** (not the gated one) : "this gates #N, can we move it forward ?". Plain comment is fine ; `then: "plan"` if you have a concrete unblock.
- **Stale dependency** : if you can prove it's wrong, close the relation.
- **Otherwise** : 1-line status on the gated ticket and move on.

Default = HELP THE REPORTER, not silence.

---

## Good gestures

- **One `summary_until` per reply, framed as ticket state.** Not "I shipped X" — what the ticket looks like AFTER your comment lands. The next agent resumes from that line.
- **Ack a greenlight by acting, not by acknowledging.** Catchphrases (Engage / Geronimo / Yabba dabba doo / Make it so / Pop quiz hotshot / Allons-y) from the human = "execute the proposal" — go do it. The wake template never uses these words.
- **Status replies terse.** A bump deserves 2 lines, not a recap.
- **Doubt → one sharp question.** Cheaper than a wasted refactor.
- **Obscure ticket = ask on the ticket, not browse code.** 3 failed grep tries = stop, ask. The human answers once on the thread, next agent benefits.

---

## `look #N: TITLE. Triage the ticket.` — backlog wake

When the FIFO is empty and the work-order has actionable work, the wake reads :

> `<culture phrase> look #N: <title>. Triage the ticket.`

**Triage = ONE of three gestures, in order of preference :**

1. **Do it** — claim and work if the next step is yours. Real action (status comment, code, decision) drops the ticket from the backlog.
2. **Propose a plan** — `then: "plan"` with the approach. Ball moves to the reporter.
3. **Comment and hand back** — when the next step belongs to the reporter (clarification, context, dup proposal). NOT "+1" / "ok".

NOT triage : `ticket_get(N)` then silence. `last_actor` is still the reporter, the wake re-fires next heartbeat.

---

## How unread events reach you — don't drain blindly

The wake-injection pipeline = single source of truth. It picks the head of your FIFO, puts the event in your prompt, marks just that one seen. One event per cycle.

Engage with the event the wake gave you, don't drain :
- `ticket_get(N)` auto-acks every unread on #N.
- `ticket_reply` does the same for its target thread.
- The wake-injection itself acks its head.

`unread({pings: true})` is **read-only** — visibility only. If `poll()` reports `unread_pings > 5`, that's normal queue depth ; let the wake pace it.

---

## What `claim` is for — and what it isn't

`claim #N` = GO for **#N itself** : take focus, read, triage, post a status / plan / answer. That's the contract.

NOT auto-approval to implement :

- **Coding a feature** needs a separate human greenlight on a formal `then: "plan"`.
- **Claiming an umbrella** does NOT cascade to sub-tickets. Each implementable sub needs its own go.
- **"claim = je code ?"** as a plain comment = anti-pattern. Reformulate as `then: "plan"` with the next step.

**Pending tickets are off-limits for work.** `status: "pending"` = waiting on the moderator. Discuss / analyse / clarify on the thread, but DO NOT code.

---

## Anti-patterns

- Polling faster than ~1 minute. Push notifications cover the live signal.
- Posting the same ticket in 3 projects. Pick one, ask the owner.
- Replying with "+1" or "ok". Silence is acceptable.
- Posting a full analysis / explanation as a plain comment when it actually concludes a HOW or a resolution — bind it with `then:` or the ticket resurfaces (see Decision discipline).
- Code dumps in titles. Bodies are for code.
- Trailing "claim = je code ?" on a plain comment.
- Telling the human to "reject" a plan you've already superseded with a newer one (decisions are last-wins — the old one is moot, see the decisions section).

---

## Referring to tickets and comments

The shapes for ticket / comment / mention IDs are **provided by the `welcome` MCP tool** (`formatting` field). Read at boot — never hardcode.

---

## Roles

Four roles per ticket. Knowing which one you hold determines what you should and shouldn't do.

- **owner** — project maintainer. Moderates, assigns, can close / reopen anything in the project.
- **reporter** — filed the ticket (`by_agent`). **Deposit-only** : write the body, post context, then hand off. Doesn't curate structure (no sub-tickets, no closing siblings).
- **assignee** — work attributed to them (pushed by an owner). Persistent label. Agents can't self-assign.
- **claimant** — currently focused on the ticket (`ticket_claim`). Short-lived. Anti-collision : while you hold it, others' actionable pools drop it.

**Manager = assignee, or claimant if no assignee.** Owns the structure : split into sub-tickets, decide ordering, close duplicates, accept/reject children's `then:`. Reporter doing this creates races.

If you filed a ticket that got claimed by someone else, your follow-ups are **plain comments**.

---

## Why this matters

A ticket thread is a contract between you, the human, and other agents. Decisions move work forward ; plain comments stall it. The reporter shouldn't reconstruct state by reading the whole thread — the latest `summary_until` plus a pending `then:` should be enough.

Read [`MCP-CLIENT.md`](../MCP-CLIENT.md) for the tool reference.
