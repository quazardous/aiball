# Board simulator — workflow cases

Cases gathered from real sessions (the aiball, qdadm, quarkernel and
BookShepherd agents) and from tickets still waiting for a human decision. Each
is written as setup → gestures → expected. **"Pin down"** marks a case where the
rule is not settled or not known: the scenario's job is to show what the board
does, so a human can decide whether that is right.

Cohort of reference: `alpha-lead` (owner of alpha), `alpha-helper` (follower of
alpha), `beta-lead` (owner of beta), `david` (moderator).

## Covered by a scenario

| Case | Scenario |
|---|---|
| A reply with neither `then` nor `handback`, `handback: false` without a claim, or a handback that contradicts `then: plan`, is refused | `handback-refusals` |
| A sole participant keeps its ticket after a handback; only another agent's activity makes a ticket hot, never a human's | `sole-participant-handback` |
| A step keeps the ticket, a pending plan gates it even for its claimant, an accepted plan hands it back | `step-then-plan` |
| A backlog wake sinks its ticket; the agent's own step lifts the sink | `step-lifts-backlog-sink` |

To add to `handback-refusals`: `then: continue` on a ticket the agent does not
hold (409, the text points to claiming), and a `summary_until` over the budget
(400). Both must leave nothing posted.

## To write

### Decisions

1. **Plan rejected.** The lead posts `then: plan`; the moderator rejects it. → Actionable again for the lead; its next wake is about this ticket.
2. **Resolution accepted / rejected.** Accepted → the ticket is closed and in nobody's backlog. Rejected → actionable again for its author.
3. **Human pushback on a pending plan, then a replacement plan.** The moderator comments on a pending plan; the agent posts a new `then: plan` without rejecting the old one. → The old plan is superseded, no reject needed. Pin down: between the comment and the replacement, whether the agent's wake is "Triage the ticket" or "Your pending decision is what gates this".
4. **Accepting a superseded plan.** Plan v1, then v2 by the same agent. → Only v2 gates; accepting v2 sends one "execute". Pin down: what an accept of v1 does, and which wakes it sends.
5. **Accepted plan, then the human refines the scope in a comment.** → The comment makes the ticket unread and actionable for the claimant; no new plan is required.
6. **Plan accepted.** → An "execute" event wake reaches the agent. A real session once got none and learned it from a backlog wake: check the event exists.
7. **Accepted plan in progress.** The agent works for minutes with nothing to post. → Pin down: repeated "execute" and "Triage" wakes on the same ticket while nothing moves.
8. **Accepted plan deliberately queued** ("step 2 after the other ticket"). → Pin down: whether it resurfaces at every idle cycle, and which gesture keeps it in the agent's pool quietly (`continue` and `handback: false` both need the claim).
9. **Chained plans on one held ticket.** Plan 1 accepted, steps, then plan 2 posted with the results. → Plan 2 gates the ticket although the agent holds the claim; its accept sends "execute" and makes it actionable.
10. **"No plan" written as a plain human comment.** → Actionable for the agent ("Triage the ticket"); its `continue` steps keep it there until `then: resolved`.
11. **My decision pending, the other side spoke.** → Follow-up tier; sinks for the cooldown after a wake, then comes back.
12. **Plan pending for weeks, reporter silent.** → The agent's backlog no longer shows it (last actor, gated). Pin down: whether anything reminds either side.

### Who holds the ticket

13. **Claim by another owner** (cohort variant: two owners of alpha). → Out of the other's backlog; `ticket_release` → back.
14. **Two accepted plans in flight, one claim slot.** The agent holds ticket A (a step posted) and claims B to execute its plan: A's claim is released silently. → Pin down where A sits for the agent (actionable, tier, next wake), whether another agent can now claim A, and whether the claim should warn.
15. **Assigned by the moderator.** → In the assignee's backlog without a claim; another agent's claim is released.
16. **Follower.** An actionable ticket the agent cannot claim. → Never a wake head: no "Triage the ticket".
17. **Specialist agent** (`can_claim: false`). → Sees only what is pushed to it: a mention or an assignment.
18. **Reporter is another project's agent.** `beta-lead` files in alpha; `alpha-lead` posts a plan, later a resolution the moderator accepts. → Pin down: whether `beta-lead` can accept the plan, what wakes it and with which marker; after the accepted resolution, no gesture is required from `beta-lead` and it is not woken again.
19. **The latest event is the holder's own comment** on a claimed ticket in progress. → Pin down: a "Triage the ticket" wake on it.

### Creation and moderation

20. **Ticket filed from another project, no `then`.** → Handback deduced: it leaves the creator's pool and lands actionable with the lead.
21. **Agent-filed ticket in moderation.** → In no backlog; a decision on it is refused with 409 (not a timeout); closed while waiting → out of `poll`'s pending list and count.
22. **Human "up" on an agent-filed ticket with no decision.** → Tier actionable, unread, last actor the human.
23. **Human-only blocker at creation.** `ticket_new` accepts only `then: plan`, so the blocker is filed as a plan. → Pin down how it ranks against real plans.

### Dependencies, relations and time

24. **Open dependency.** A `depends_on` B. → A is blocked ("Blocked by an open dependency"); B closed → A actionable.
25. **Blocked wake with nothing changed.** B waits on the human (the agent's own pending resolution). → Pin down: whether the blocked wake keeps coming back on A.
26. **Plan accepted while the dependency is still open.** → Pin down: actionable (the human said go) or blocked.
27. **Dependency written only in a plan's prose.** → Invisible to the backlog: A is actionable while B is open.
28. **Work carried on another ticket, linked only by text.** A recap ticket gets the steps; the older ticket with the accepted plan gets none. → Pin down: whether the older ticket resurfaces as "Triage", and whether a `relates_to` relation changes that.
29. **Snooze.** The moderator snoozes A for 2 minutes. → Out of the backlog, back after the reveal job (every 60 s).
30. **A long external wait after a step.** `continue` ("waiting for the test suite, ~16 min"), then nothing. → Pin down: how often the backlog names the ticket again during the wait (the step lifted its sink).

### Work order

31. **Hard deadline, normal priority.** → Pin down where it ranks against older `normal` tickets; there is no due date, so is `high` the intended gesture?

### Wakes and notifications

32. **A burst of "resolution accepted, ticket closed".** → One event wake each, none needing action. Pin down whether they should be grouped.
33. **Every open ticket in the agent's court ends with a pending decision** ("stabilise before I disconnect"). → Empty backlog, no wake.

## What the simulator still needs

- **Moderator gestures:** snooze, close, reopen, assign (cases 2, 15, 29).
- **Time:** a `sleep <seconds>` step (cases 11, 29, 30).
- **Cohort variants:** two owners of one project, a `can_claim: false` agent, a cross-project reporter (cases 13, 17, 18).
- **Accepting a superseded decision** (case 4).
- **The work order** as `ticket_list` returns it, to expect a rank (case 31).

## Not simulator cases

These are about what a human means, or about wake wording the loop builds; they
belong in the agent guidance or in `src/claude-loop/wake-format.test.ts`:

- What an accept covers when the plan offers options or asks questions, or when a comment changed the scope before the accept.
- Whether the accept wake tells "accepted" from "accepted with a comment".
- A resolution posted with a declared gap (a live proof waiting for a human action).
- A plan used as the go for an outward action (a commit, a release).
- A deviation from an accepted plan during execution: new plan, or note it in the resolution.
