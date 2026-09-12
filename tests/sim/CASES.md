# Board simulator — workflow cases

Cases gathered from real sessions (the aiball, qdadm, quarkernel and
BookShepherd agents) and from tickets still waiting for a human decision. Each
is written as setup → gestures → expected. A case whose rule was not settled
was played to show what the board does, and david decided each one; those still
waiting for their change are listed below, with their ticket. Numbers are
stable: a case keeps its number when it moves.

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
| Answering a backlog wake leaves the ticket sunk for the cooldown — the agent's own word is not news; anyone else's lifts the sink at once | `wake-answered-stays-sunk` |
| An agent carried on but handed the ticket back; the moderator tags its reply as a step: the ticket is the agent's again, its last actor unchanged, and the agent is not notified | `moderator-step-tag` |
| 1 — A rejected plan hands the ticket back, with a `plan_rejected` event | `decision-plan-rejected` |
| 2 — An accepted resolution closes the ticket, a reopen brings it back, a rejected resolution hands it back | `decision-resolution` |
| 3 — A pushback on a pending plan hands the ticket back with the plan still pending; the agent's replacement supersedes it without a reject | `decision-pushback-replacement` |
| 3, 11 — A human's comment on a pending decision hands the ticket back to its agent, which must confirm or amend its `then:`; another agent's comment decides nothing, so the gate holds | `decision-pending-other-spoke` |
| 4 — Only the latest decision of a thread can be accepted or rejected: a replaced one is refused with its reason | `decision-accept-superseded` |
| 5 — A human comment refining an accepted plan reaches the claimant; no new plan is needed | `decision-scope-refined` |
| 6 — Accepting a plan sends its author a `plan_accepted` event | `decision-accept-sends-execute` |
| 7 — An accepted plan being worked with nothing to post: every cooldown names the ticket again. Decided: the nudge stays; starting before the accept is the agent's discipline | `decision-accepted-plan-in-progress` |
| 8 — An accepted plan queued behind another ticket: a `depends_on` relation and a reply that keeps the hand block it quietly, and the other ticket's close brings it back with `dependency_closed` | `decision-accepted-plan-queued` |
| 9 — A second plan on a held ticket gates it until accepted, then sends `plan_accepted` again | `decision-chained-plans` |
| 10 — "No plan" in a plain human comment makes the ticket the agent's; its steps keep it there | `decision-no-plan-comment` |
| 12 — A plan pending and nobody answers: nothing reminds either side. Decided: a pending plan is the human's (or, later, the pilot's) — no reminder | `decision-plan-pending-silent` |
| 13, 15, 29 — Two owners: a claim takes the ticket out of the other's backlog, a release brings it back; an assignment puts it with the assignee; close and reopen; a snooze hides it until it ends; the work order puts a high-priority ticket first | `moderator-gestures` |
| 16 — A follower sees an actionable ticket it cannot claim, and no backlog wake ever names it | `holder-follower-never-head` |
| 17 — A `can_claim: false` specialist does not see a ticket until it is assigned to it | `specialist-pushed-only` |
| 18 — The reporter of a ticket filed in another project hears the agent's comments and the close, but not the outcome of decisions it cannot take | `holder-reporter-other-project` |
| 19 — The holder's own comment on a ticket in progress still gets a triage wake. Decided: the backlog is a coaching loop | `holder-own-comment` |
| 20 — A ticket filed on another project with no `then` leaves its creator and lands actionable with that project's lead | `creation-cross-project-no-then` |
| 21 — An agent's ticket waiting for moderation is in no backlog; a decision on it is refused at once (409); closed while waiting, it stays out | `creation-pending-ticket` |
| 22 — A human "up" on an agent's ticket with no decision: actionable, unread, the human its last actor | `creation-human-up` |
| 23 — A blocker filed with `then: plan` behaves like any plan: whoever files it, a human files it and a human accepts it — nothing auto-accepts. It reads as follow-up for the project's other owner where an ordinary pending plan shows nowhere; decided: harmless, a project may carry tickets of its own shape | `creation-blocker-as-plan` |
| 24, 32 — A ticket waiting on another (`depends_on`) is blocked and gets `dependency_closed` the moment the blocker closes; a ticket merely linked to it gets `related_closed`, news rather than a gate | `dependency-closed` |
| 25 — A blocked ticket keeps surfacing while nothing moves, but only after twice the cooldown (`tickets.blocked_cooldown_multiplier`): not forgotten, and not nagging | `dependency-blocked-wake-repeats` |
| 26 — A plan accepted while the ticket's dependency is still open leaves it blocked. Decided: no extra gate in the UI; an umbrella may be accepted with its children unfinished | `dependency-plan-accepted-while-blocked` |
| 27 — A dependency written only in a plan's prose is invisible: the ticket is actionable while the other is open | `dependency-in-prose-only` |
| 28 — Work carried on a recap ticket leaves the older one coming back as "Triage". Decided: a piloting matter — the agent says so on the older ticket | `dependency-work-on-recap-ticket` |
| 31 — A hard deadline with normal priority ranks after older tickets; `high` is the intended gesture | `order-deadline-normal-priority` |
| 32 — A burst of accepted resolutions keeps one wake per closed ticket: a close sometimes unblocks work, so they are not grouped | `notify-burst-of-accepts` |
| 33 — Every open ticket in the agent's court ends with a pending decision: empty backlog, no wake | `notify-all-pending-decisions` |

## Decided, the change is in a ticket

What the board does today, and what david decided about it. Each scenario below
still plays TODAY's behaviour; it becomes a written expectation when its ticket
lands, and the case then moves to "Covered".

- **14 — claiming a ticket another agent holds** goes through with no refusal, no warning and no trace on the thread (ticket #2379). Scenario `holder-claim-slot`.
- **30 — waiting on a machine has no gesture of its own**: during a CI wait the ticket is named every 5 minutes. Nothing changes for now; a dated wake filed by the agent is under study (ticket #2381). Scenario `dependency-external-wait-after-step`.

## Not simulator cases

These are about what a human means, or about wake wording the loop builds; they
belong in the agent guidance or in `src/claude-loop/wake-format.test.ts`:

- What an accept covers when the plan offers options or asks questions, or when a comment changed the scope before the accept.
- Whether the accept wake tells "accepted" from "accepted with a comment".
- A resolution posted with a declared gap (a live proof waiting for a human action).
- A plan used as the go for an outward action (a commit, a release).
- A deviation from an accepted plan during execution: new plan, or note it in the resolution.
