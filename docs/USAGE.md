# Using aiball: a pilot's board, not an agent farm

> **The spaghetti plates theorem** (Berlioz, 2026)
> For an agent with a finite context window *C*, the probability of producing
> spaghetti tends to 1 as the project size *P* exceeds *C*.
> Splitting *P* into *n* sub-projects *pᵢ < C* does not reduce the total
> complexity, but it bounds the local complexity the agent must handle at any
> time *t*.
> *Corollary:* many small plates stay more digestible than one huge one.

A joke, with serious relatives: Tesler's law of conservation of complexity
(complexity can be moved, never destroyed) and Lehman's laws of software
evolution (a system that keeps changing grows more complex unless work goes into
reducing it). aiball is built around the corollary.

## What aiball is not

- **Not an agent farm.** It does not spawn an agent per task and throw it away
  when the task is done.
- **Agents are persistent**: one per project — a lead, sometimes with a small
  crew — each a Claude Code session that keeps its context from one turn to the
  next. A human creates them, from the command line (`claude-loop start
  --init`); an agent does not create another.
- **The human decides the software** — what to build, what not to, which
  approach. Agents write the code. A plan or a resolution an agent proposes
  waits for the ticket's reporter, usually you, to accept or reject it.

## The daily loop

1. **You file a ticket**, on the board — from your laptop, or from your phone
   over [Tailscale](./TAILSCALE.md).
2. **The project's agent picks it up when it is free**: at the end of its
   current turn, or as soon as it goes idle. It never interrupts a turn in
   progress, and it holds back while you are typing in its session.
3. **When the approach matters, it proposes a plan** on the thread. You accept
   or reject it, right under the comment.
4. **It does the work and proposes a resolution.** Accept it and the ticket
   closes; reject it and the ball is back in the agent's court.
5. **At any time, you can take the wheel**: attach to the session and type, or
   press **F9** to hold the loop off while you drive. Direct or backlog — same
   session, same context.

## Between projects

Each project stays a small plate, but the plates have to talk, and tickets are
what they talk with:

- an agent that needs something from another project files a ticket there,
  marked with the project it comes from, and that project's agent handles it
  like any other;
- a project can follow another and hear about the changes flagged as broadcast;
- a ticket filed in the wrong project can be moved, thread and all.

Above the projects, a **CTO agent** works on the steering levels — milestones
and the roadmap — while coders work on tasks. See *Starting a CTO agent* in
[`CLAUDE-LOOP.md`](./CLAUDE-LOOP.md).

## Where to go next

- [`README.md`](../README.md) — install and your first ticket.
- [`CLAUDE-LOOP.md`](./CLAUDE-LOOP.md) — how the loop wakes an agent, the
  presence model behind F9, starting a CTO agent.
- [`TICKET_LIFECYCLE.md`](./TICKET_LIFECYCLE.md) — ticket states, decisions,
  and who holds the ball.
- [`MCP-CLIENT.md`](../MCP-CLIENT.md) — what agents do with tickets.
- [`REMOTE.md`](./REMOTE.md) — a project whose loop runs on another machine.
