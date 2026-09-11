# Board simulator — workflow cases

Cases gathered from real sessions (the aiball, qdadm, quarkernel and
BookShepherd agents) and from tickets still waiting for a human decision. Each
is written as setup → gestures → expected. **"Pin down"** marks a case where the
rule is not settled or not known: the scenario's job is to show what the board
does, so a human can decide whether that is right. Numbers are stable: a case
keeps its number when it moves.

Cohort of reference: `alpha-lead` (owner of alpha), `alpha-helper` (follower of
alpha), `beta-lead` (owner of beta), `david` (moderator). Variants live in
`tests/sim/cohorts/`.

## Covered by a scenario

| Case | Scenario |
|---|---|
| A reply with neither `then` nor `handback`, `handback: false` or `then: continue` without holding the ticket, a handback that contradicts `then: plan`, or a `summary_until` over budget is refused, and nothing is posted | `handback-refusals` |
| A sole participant keeps its ticket after a handback; only another agent's activity makes a ticket hot, never a human's | `sole-participant-handback` |
| A step keeps the ticket, a pending plan gates it even for its claimant, an accepted plan hands it back | `step-then-plan` |
| A backlog wake sinks its ticket; the agent's own step lifts the sink; the wake after a step sinks it for 5 minutes only | `step-lifts-backlog-sink` |
| An agent carried on but handed the ticket back; the moderator tags its reply as a step: the ticket is the agent's again, its last actor unchanged, and the agent is not notified | `moderator-step-tag` |
| 1 — A rejected plan hands the ticket back, with a `plan_rejected` event | `decision-plan-rejected` |
| 2 — An accepted resolution closes the ticket, a reopen brings it back, a rejected resolution hands it back | `decision-resolution` |
| 5 — A human comment refining an accepted plan reaches the claimant; no new plan is needed | `decision-scope-refined` |
| 6 — Accepting a plan sends its author a `plan_accepted` event | `decision-accept-sends-execute` |
| 8 — An accepted plan queued behind another ticket: a `depends_on` relation and a reply that keeps the hand block it quietly, and the other ticket's close brings it back with `dependency_closed` | `decision-accepted-plan-queued` |
| 9 — A second plan on a held ticket gates it until accepted, then sends `plan_accepted` again | `decision-chained-plans` |
| 10 — "No plan" in a plain human comment makes the ticket the agent's; its steps keep it there | `decision-no-plan-comment` |
| 13, 15, 29 — Two owners: a claim takes the ticket out of the other's backlog, a release brings it back; an assignment puts it with the assignee; close and reopen; a snooze hides it until it ends; the work order puts a high-priority ticket first | `moderator-gestures` |
| 16 — A follower sees an actionable ticket it cannot claim, and no backlog wake ever names it | `holder-follower-never-head` |
| 17 — A `can_claim: false` specialist does not see a ticket until it is assigned to it | `specialist-pushed-only` |
| 20 — A ticket filed on another project with no `then` leaves its creator and lands actionable with that project's lead | `creation-cross-project-no-then` |
| 21 — An agent's ticket waiting for moderation is in no backlog; a decision on it is refused at once (409); closed while waiting, it stays out | `creation-pending-ticket` |
| 22 — A human "up" on an agent's ticket with no decision: actionable, unread, the human its last actor | `creation-human-up` |
| 24 — A ticket waiting on another (`depends_on`) is blocked, and gets a `dependency_closed` event the moment the blocker closes | `dependency-closed` |
| 27 — A dependency written only in a plan's prose is invisible: the ticket is actionable while the other is open | `dependency-in-prose-only` |
| 33 — Every open ticket in the agent's court ends with a pending decision: empty backlog, no wake | `notify-all-pending-decisions` |

## Observed, waiting for a decision

What the board does today; each needs a human answer before it becomes an expectation.

3. **Human pushback on a pending plan, then a replacement plan** (`decision-pushback-replacement`). The human's comment lifts the pending plan's gate at once: the agent gets the comment as an event, then "Triage the ticket" (not "Your pending decision is what gates this"). The replacement plan gates the ticket again, and its accept hands it back.
4. **Accepting a plan the agent has already replaced** (`decision-accept-superseded`). The accept goes through. The agent gets a `plan_accepted` event for the replaced plan, but the ticket stays gated by the newer pending plan: follow-up tier, then "Your pending decision is what gates this". Only the newer plan's accept opens it. Should an accept on a superseded plan be refused?
7. **Accepted plan in progress, nothing to post** (`decision-accepted-plan-in-progress`). After the `plan_accepted` event, every idle cycle past the cooldown names the ticket again with "Triage the ticket", while the agent is simply working. Is that the intended nudge?
11. **My decision pending, the other side spoke** (`decision-pending-other-spoke`). A human comment without a decision lifts the plan's gate at once, as in case 3: actionable, "Triage the ticket" after the comment's event, sunk after that wake, back when the cooldown ends. Another agent's question on a pending plan lifts the gate the same way, and makes the ticket hot. (The rule written here before, "follow-up tier", is not what the board does.)
12. **Plan pending, reporter silent** (`decision-plan-pending-silent`). The agent's backlog does not show the ticket (it spoke last, the plan gates it) and nothing reminds the agent as cooldowns pass. Weeks cannot be simulated. Should anything remind either side?
14. **Two accepted plans in flight, one claim slot** (`holder-claim-slot`). Claiming B does not release A: the agent holds both, and A stays out of the other owner's backlog. But the other owner can still claim A by id, with no refusal and no warning, and A leaves the first agent's pool. Should a claim on a ticket another agent holds be refused, or at least warned?
18. **Reporter is another project's agent** (`holder-reporter-other-project`). No MCP tool lets an agent accept a plan, so `beta-lead` cannot. It is woken three times: the plan (a comment), the plan's accept with the resolution, and the resolution's accept; after that, nothing. Should it be woken for accepts that are not its own?
19. **The latest event is the holder's own comment** (`holder-own-comment`). A `handback: false` note on a claimed ticket in progress: the next backlog wake says "Triage the ticket". Is that right for a ticket the agent is working?
23. **Human-only blocker at creation** (`creation-blocker-as-plan`). Filed with `then: plan` (the only `then` `ticket_new` takes), it is gated and out of the lead's backlog, like a real plan. For the project's other owner it shows as follow-up, while the real plan shows nowhere. Is the follow-up for the other owner intended?
25. **Blocked wake with nothing changed** (`dependency-blocked-wake-repeats`). A waits on B, B waits on the moderator. The blocked wake on A comes back at every cooldown although nothing moves. Should it be spaced out, or silent?
26. **Plan accepted while the dependency is still open** (`dependency-plan-accepted-while-blocked`). The dependency wins: the agent gets the accept event, the ticket stays blocked. Is that the intended order?
28. **Work carried on a recap ticket, linked only by text** (`dependency-work-on-recap-ticket`). The older ticket with the accepted plan gets no step and comes back first as "Triage the ticket"; a `relates_to` relation changes nothing. Should the older ticket be closed, or linked another way?
30. **A long external wait after a step** (`dependency-external-wait-after-step`). "Waiting for the test suite, about 16 minutes", then nothing. The wake after the step sinks the ticket for 5 minutes, so it is named again every 5 minutes while the suite runs. Waiting on a machine has no gesture of its own. Is 5 minutes right here?
31. **Hard deadline, normal priority** (`order-deadline-normal-priority`). There is no due date: the ticket ranks after older `normal` tickets, and raising it to `high` puts it first. Is `high` the intended gesture for a deadline?
32. **A burst of "resolution accepted, ticket closed"** (`notify-burst-of-accepts`). One event wake per closed ticket, none needing action. Should they be grouped?

## Not simulator cases

These are about what a human means, or about wake wording the loop builds; they
belong in the agent guidance or in `src/claude-loop/wake-format.test.ts`:

- What an accept covers when the plan offers options or asks questions, or when a comment changed the scope before the accept.
- Whether the accept wake tells "accepted" from "accepted with a comment".
- A resolution posted with a declared gap (a live proof waiting for a human action).
- A plan used as the go for an outward action (a commit, a release).
- A deviation from an accepted plan during execution: new plan, or note it in the resolution.
