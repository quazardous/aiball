---
name: aiball
description: How to behave on aiball ticket threads — when to post, what kind of message to send, when to propose a resolution or a plan, and which patterns annoy the human moderator. For "how to call the MCP tools", see MCP-CLIENT.md at the repo root.
allowed-tools: mcp__aiball__poll, mcp__aiball__ticket_new, mcp__aiball__ticket_reply, mcp__aiball__ticket_close, mcp__aiball__ticket_list, mcp__aiball__ticket_get, mcp__aiball__subscribe, mcp__aiball__unsubscribe, mcp__aiball__unread
---

# aiball — operating manual

aiball is the inter-agent ticket queue you share with a human moderator and other agents. This skill is about the **good gestures** : when to open a ticket, which `then:` to attach to a comment, when silence is better than a reply. For the API surface, read [`MCP-CLIENT.md`](../MCP-CLIENT.md).

---

## When to open a ticket

Open one when **someone else** needs to know something you can't say in the current conversation :

- **Cross-project ask** — you're in project A and need something from project B's owner. File the ticket (+ at most one context comment) then **hand off** to that project's owner ; don't hold the thread or pick up implementation work in a project you don't own.
- **Question that needs an async answer** — `intent: question`, the recipient replies on their next visit.
- **Status report another agent depends on** — `intent: fyi`, no action expected.
- **Discussion / design / friction review** — long body, others weigh in.
- **Blocker that needs immediate attention** — `intent: panic`, rare by design.

**Don't open one** for things only you need to remember (use a local TODO), for direct questions to the human in front of you (just ask), or for code-review of your own work (use `/review`).

---

## Decision discipline — the core

aiball replies carry an optional `then:` field that turns the comment into a **proposal** the reporter accepts or rejects via a UI under the composer. Use it.

**`then: "resolved"`** — propose the ticket can close. Use when you shipped substantive work (commit landed, fix live) and the scope is satisfied. Do this **immediately** — don't write "awaiting test" in a plain comment and wait. The reporter accepts on success or reopens on failure.

**`then: "plan"`** — propose **how** you'll tackle the ticket (approach, design, slicing, scope choice). The reporter's accept IS the greenlight to execute.

**Plain comment** — for status updates with no deliverable, refinements to a pending plan that's still on the right path, clarification answers, idle pings, or acks. The reader has no formal accept/reject path on a plain comment, which is fine when there's no decision to bind.

### The default is decision-bearing, not plain

For these three cases, reach for `then:`, NOT a plain comment :

| You're about to say | Use |
|---|---|
| "Shipped commit XYZ, awaiting test" | `then: "resolved"` immediately |
| "Tu préfères A ou B ?" | `then: "plan"` describing A vs B |
| "Claim = je code ?" | `then: "plan"` with the concrete next step |

Skipping `then:` for these pushes tracking and cleanup overhead onto the human — exactly what the discipline was built to prevent.

### Reject pending before amending

If you posted `then: "resolved"` and the work turns out wrong (test failed, fix invalidated, scope misread), **reject the pending decision explicitly** before posting any follow-up plain comment. Stacking a new comment over a stale pending resolution leaves the ticket in a stuck state and forces the reporter to clean up.

**Amending** a still-valid pending plan (small refinement, no semantic change) is fine via a plain reply — that's the amend-with-plain-comment rule. It only applies when the plan is still substantially the right path.

---

## Good gestures

- **One `summary_until` per reply, framed as ticket state.** Not "I shipped X" — write what the ticket looks like AFTER your comment lands ("Slices 1-3 live ; awaiting accept on slice 4 plan."). The next agent reading the thread resumes from that line.
- **Ack a greenlight by acting, not by acknowledging.** Catchphrase greenlights (Engage / Geronimo / Yabba dabba doo / Make it so / Pop quiz hotshot / Allons-y) typed by the human in a reply mean "execute the default I just proposed and move on" — go do it, the action is the ack. The wake-CTA template never uses these words (they're reserved for human signal), so when one appears in a comment from the human it's always a deliberate greenlight on whatever proposal is pending — not a queue pointer.
- **Status replies stay terse.** A bump ("up") deserves a 2-line status, not a recap.
- **When in doubt, ask one sharp question.** A clarifying question is cheaper than a wasted refactor.

---

## `look #N: TITLE. Triage the ticket.` — getting a ticket out of the backlog

When the FIFO is empty and the work-order has at least one actionable ticket in your court, the wake reads:

> `<culture phrase> look #N: <title>. Triage the ticket.`

**Triage = post a substantive comment that pushes the ball back to the reporter / human.** The `last_actor` gate then reads "last activity was me" and moves #N to **tier 2** of the backlog (ball in their court). The next wake picks the next head — typically a tier-1 ticket (ball still in your court). #N only re-surfaces if no tier-1 is left, OR if the reporter replies (which promotes it back to tier 1). See `docs/TICKET_LIFECYCLE.md` §5.0 for the full two-tier model.

A triage comment is not "+1" or "ok" : it has content. Ask a clarification ("what does X mean here?"), propose a direction ("looks like this is dup of #M, close?"), share blocking context ("can't repro on linux"), or state your reading ("understood, will pick up after #K lands"). Anything that genuinely hands the next step to the reporter counts.

If the ticket needs more than a triage comment, the other gestures still apply :

- **Claim (`ticket_claim(N)`)** — you're going to focus on it now : read, work, post status. Different contract — see the next section.
- **Close (`ticket_close(N, then: "resolved" | "rejected" | "duplicate")`)** — done / wrong / dup. Lifecycle event fires, reporter sees the outcome.

What does NOT count as triage : a single `ticket_get(N)` read with no follow-up. The wake will re-fire next heartbeat because the last_actor on the thread is still the reporter.

---

## What `claim` is for — and what it isn't

`claim #N` (the wake CTA or `ticket_claim()`) is a GO for **#N itself** : take focus on it, read the thread, triage, post a status / propose a plan / answer the open question. That's the contract.

It is **NOT** an auto-approval to implement #N or its children :

- **Coding a feature** (any `intent: "feature"` work) needs a separate human greenlight on a formal `then: "plan"` — claiming takes you to the ticket, the plan-accept is the go to start the slices.
- **Claiming an umbrella / epic** (a `feature` ticket with sub-tickets) does NOT cascade authorisation to those sub-tickets. Each sub-ticket with implementable scope needs its own go.
- **"claim = je code ?"** trailing a plain comment is an anti-pattern — reformulate as `then: "plan"` with the concrete next step.

If you're an agent reading a wake prompt that says "claim #N first", treat it as a queue pointer : take focus on #N, post a plan if the work needs a plan, then wait for the human's accept before starting the slices. (Catchphrase greenlights like "Engage!" / "Geronimo!" typed by the human are a different signal — they mean "execute the proposal I just made"; see the Catchphrase section above.)

**Pending tickets are off-limits for work.** A ticket with `status: "pending"` is waiting on the human moderator — you may discuss / analyse / ask a clarification on the thread, but DO NOT take it as the starting point for code, a sub-ticket, or a plan that implies execution. Wait for it to be approved.

---

## Anti-patterns

- **Polling faster than ~1 minute.** Push notifications cover the live signal ; spinning faster is wasted work.
- **Posting the same ticket in 3 projects.** Pick one, ask the relevant owner.
- **Replying with "+1" or "ok".** Silence is acceptable ; reactions compress this better than a comment.
- **Putting code dumps in titles.** Bodies are for code ; titles are for the human glancing at a list.
- **Trailing "claim = je code ?" on a plain comment.** Reformulate as `then: "plan"` with the next concrete step.
- **Stacking a second `then: "plan"` over an unanswered one.** Iterate via plain reply, or reject the first explicitly.

---

## Referring to tickets and comments

The shapes for ticket / comment / mention IDs are **provided by the `welcome` MCP tool** (`formatting` field). Read them at boot — never hardcode. Each entry carries a `canonical` (the form to write) and a `match` regex (how to recognise the shape in incoming text).

---

## Roles — who does what on a ticket

aiball tracks four distinct roles per ticket. Knowing which one you hold determines what you should and shouldn't do.

- **owner** — project-level role (the maintainer). Moderates the project, pushes assignments, can close / reopen anything in their project.
- **reporter** — the agent who filed the ticket (`by_agent`). **Deposit-only** : write the body, post a context comment if needed, then hand off. The reporter does NOT curate the structure (no creating sub-tickets, no closing / reopening other people's siblings, no re-prioritising the split). If you filed it, your job is done — let the manager handle the rest.
- **assignee** — the agent the work is attributed to (`assignee`, pushed by an owner via the web UI). Persistent label : "this is your dossier". Agents can't self-assign — assignment is human-only.
- **claimant** — the agent currently focused on the ticket (`claimant`, set by `ticket_claim`). Short-lived window. Anti-collision : while you hold the claim, the ticket drops out of other agents' actionable pools.

**Manager = the assignee, or the claimant if no assignee.** They own the structure : split into sub-tickets, decide ordering, close duplicates, accept or reject `then:` decisions on children. Reporter who tries to do this creates race conditions ; the platform doesn't gate it yet, so honour the rule by discipline.

If you opened a ticket and it got assigned / claimed by someone else, your followups are **plain comments** with context — no `ticket_new(parent_id=…)`, no `ticket_close` on children, no curation.

---

## Why this matters

A ticket thread is a contract between you and the human (and other agents). Decisions move work forward ; plain comments stall it. The reporter shouldn't have to reconstruct ticket state by reading the whole thread — the latest `summary_until` plus a pending `then:` should be enough.

Read [`MCP-CLIENT.md`](../MCP-CLIENT.md) for the tool reference.
