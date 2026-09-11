# Board simulator — workflow cases

Cases gathered from real sessions (the aiball, qdadm, quarkernel and
BookShepherd agents) and from tickets still waiting for a human decision. Each
is written as setup → gestures → expected. **"Pin down"** marks a case where the
rule is not settled or not known: the scenario's job is to show what the board
does, so a human can decide whether that is right. Numbers are stable: a case
keeps its number when it moves to "Covered".

Cohort of reference: `alpha-lead` (owner of alpha), `alpha-helper` (follower of
alpha), `beta-lead` (owner of beta), `david` (moderator). Variants live in
`tests/sim/cohorts/`.

## Covered by a scenario

| Case | Scenario |
|---|---|
| A reply with neither `then` nor `handback`, `handback: false` without a claim, or a handback that contradicts `then: plan`, is refused | `handback-refusals` |
| A sole participant keeps its ticket after a handback; only another agent's activity makes a ticket hot, never a human's | `sole-participant-handback` |
| A step keeps the ticket, a pending plan gates it even for its claimant, an accepted plan hands it back | `step-then-plan` |
| A backlog wake sinks its ticket; the agent's own step lifts the sink (no cooldown after a step, by design) | `step-lifts-backlog-sink` |
| 1 — A rejected plan hands the ticket back, with a `plan_rejected` event | `decision-plan-rejected` |
| 2 — An accepted resolution closes the ticket, a reopen brings it back, a rejected resolution hands it back | `decision-resolution` |
| 5 — A human comment refining an accepted plan reaches the claimant; no new plan is needed | `decision-scope-refined` |
| 6 — Accepting a plan sends its author a `plan_accepted` event | `decision-accept-sends-execute` |
| 9 — A second plan on a held ticket gates it until accepted, then sends `plan_accepted` again | `decision-chained-plans` |
| 10 — "No plan" in a plain human comment makes the ticket the agent's; its steps keep it there | `decision-no-plan-comment` |
| 13, 15, 29 — Two owners: a claim takes the ticket out of the other's backlog, a release brings it back; an assignment puts it with the assignee; close and reopen; a snooze hides it until it ends; the work order puts a high-priority ticket first | `moderator-gestures` |
| 17 — A `can_claim: false` specialist does not see a ticket until it is assigned to it | `specialist-pushed-only` |
| 24 — A ticket waiting on another (`depends_on`) is blocked, and gets a `dependency_closed` event the moment the blocker closes | `dependency-closed` |

To add to `handback-refusals`: `then: continue` on a ticket the agent does not
hold (409, the text points to claiming), and a `summary_until` over the budget
(400). Both must leave nothing posted.

## Observed, waiting for a decision

What the board does today; each needs a human answer before it becomes an expectation.

3. **Human pushback on a pending plan, then a replacement plan** (`decision-pushback-replacement`). The human's comment lifts the pending plan's gate at once: the agent gets the comment as an event, then "Triage the ticket" (not "Your pending decision is what gates this"). The replacement plan gates the ticket again, and its accept hands it back.
4. **Accepting a plan the agent has already replaced** (`decision-accept-superseded`). The accept goes through. The agent gets a `plan_accepted` event for the replaced plan, but the ticket stays gated by the newer pending plan: follow-up tier, then "Your pending decision is what gates this". Only the newer plan's accept opens it. Should an accept on a superseded plan be refused?

## To write

### Decisions

7. **Accepted plan in progress.** The agent works for minutes with nothing to post. → Pin down: repeated "execute" and "Triage" wakes on the same ticket while nothing moves.
8. **Accepted plan deliberately queued** ("step 2 after the other ticket"). → Pin down: whether it resurfaces at every idle cycle, and which gesture keeps it in the agent's pool quietly (`continue` and `handback: false` both need the claim; the waiting gesture is the `then: wait` proposal).
11. **My decision pending, the other side spoke.** → Follow-up tier; sinks for the cooldown after a wake, then comes back.
12. **Plan pending for weeks, reporter silent.** → The agent's backlog no longer shows it (last actor, gated). Pin down: whether anything reminds either side.

### Who holds the ticket

14. **Two accepted plans in flight, one claim slot.** The agent holds ticket A (a step posted) and claims B to execute its plan: A's claim is released silently. → Pin down where A sits for the agent (actionable, tier, next wake), whether another agent can now claim A, and whether the claim should warn.
16. **Follower.** An actionable ticket the agent cannot claim. → Never a wake head: no "Triage the ticket".
18. **Reporter is another project's agent.** `beta-lead` files in alpha; `alpha-lead` posts a plan, later a resolution the moderator accepts. → Pin down: whether `beta-lead` can accept the plan, what wakes it and with which marker; after the accepted resolution, no gesture is required from `beta-lead` and it is not woken again.
19. **The latest event is the holder's own comment** on a claimed ticket in progress. → Pin down: a "Triage the ticket" wake on it.

### Creation and moderation

20. **Ticket filed from another project, no `then`.** → Handback deduced: it leaves the creator's pool and lands actionable with the lead.
21. **Agent-filed ticket in moderation.** → In no backlog; a decision on it is refused with 409 (not a timeout); closed while waiting → out of `poll`'s pending list and count.
22. **Human "up" on an agent-filed ticket with no decision.** → Tier actionable, unread, last actor the human.
23. **Human-only blocker at creation.** `ticket_new` accepts only `then: plan`, so the blocker is filed as a plan. → Pin down how it ranks against real plans.

### Dependencies, relations and time

25. **Blocked wake with nothing changed.** B waits on the human (the agent's own pending resolution). → Pin down: whether the blocked wake keeps coming back on A.
26. **Plan accepted while the dependency is still open.** → Pin down: actionable (the human said go) or blocked.
27. **Dependency written only in a plan's prose.** → Invisible to the backlog: A is actionable while B is open.
28. **Work carried on another ticket, linked only by text.** A recap ticket gets the steps; the older ticket with the accepted plan gets none. → Pin down: whether the older ticket resurfaces as "Triage", and whether a `relates_to` relation changes that.
30. **A long external wait after a step.** `continue` ("waiting for the test suite, ~16 min"), then nothing. → The step lifts the sink, so the backlog names the ticket again at the next idle cycle. Seen live; the gesture that should replace `continue` here is the `then: wait` proposal.

### Work order

31. **Hard deadline, normal priority.** → Pin down where it ranks against older `normal` tickets; there is no due date, so is `high` the intended gesture?

### Wakes and notifications

32. **A burst of "resolution accepted, ticket closed".** → One event wake each, none needing action. Pin down whether they should be grouped.
33. **Every open ticket in the agent's court ends with a pending decision** ("stabilise before I disconnect"). → Empty backlog, no wake.

Every case above can be written with the simulator's current steps (moderator
gestures, `sleep`, cohort variants, `rank`, `events`, `may_fail`).

## Not simulator cases

These are about what a human means, or about wake wording the loop builds; they
belong in the agent guidance or in `src/claude-loop/wake-format.test.ts`:

- What an accept covers when the plan offers options or asks questions, or when a comment changed the scope before the accept.
- Whether the accept wake tells "accepted" from "accepted with a comment".
- A resolution posted with a declared gap (a live proof waiting for a human action).
- A plan used as the go for an outward action (a commit, a release).
- A deviation from an accepted plan during execution: new plan, or note it in the resolution.
