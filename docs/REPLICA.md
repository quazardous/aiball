# Replica: a proxy node that keeps working when cut from its parent, and can take its place

> **Status: a design, not yet implemented.** This page states what a proxy
> node does today when it loses its parent (measured), what a replica would
> add, the choices it involves and the order to build it in. Each step gets
> its own ticket and plan once the choices are made.

A proxy node ([`REMOTE.md`](./REMOTE.md), type 1) is a relay: the daemon on
machine B forwards every client call to the daemon on machine A, which holds
the board. A replica keeps a copy of the board on B, so that:

1. **cut from A**, B's loops keep reading, answering, creating and deciding;
2. **back in touch**, what happened on each side reaches the other;
3. **the roles can switch**: B becomes the board's master and A its replica,
   when A goes away for good, when B is where the work now happens, or only
   for a while.

A node cut from the master cannot draw a number from the master's counter: a
ticket it creates while cut takes one from a range reserved for it (below).

## Today: what a cut does (measured)

Two daemons on one machine, each with its own home and config: A, the parent,
and B, a proxy node pointing at it. A client of B (as a loop on B is) makes a
few gestures; then A is stopped; then started again.

| Gesture on B | A reachable | A cut | A back |
|---|---|---|---|
| Read: `ticket.list`, `ticket.get`, `consumer.micro_status` | answers in ~30 ms | **502 after ~4.3 s** | answers |
| Create a ticket, reply | written on A | **queued** in B's spool (`{ queued: true }`) | **lost** (see below) |
| Events (the bus subscriptions a loop wakes on)\* | relayed | the relayed connection closes | reopened by the client |
| Wakes (the loop asks for its next event)\* | work | fail like any read: no wake | work |

\* Read in the code, not measured.

**The spool loses its writes on a proxy node.** The client spools a write
when its daemon answers 5xx, and the daemon replays its spool by calling its
own method table. On a proxy node that table writes to a local database that
is empty (B creates one at boot, migrations only): the replay is refused
(`PROJECT_NOT_FOUND`, `TICKET_NOT_FOUND`) and the file moves to
`spool/failed/` within a second. When A comes back nothing is replayed. So
the resilience the proxy's design counted on ("the local client spools the
write for replay") does not hold today; fixing it comes first (step 1).

## What is already there to build on

- **Every write is one method call** on the bus (`message.post`,
  `message.decide`, `ticket.close`…), made by a known caller, checked by the
  method, and most of them keyed: a write carries an **idempotency key** its
  author draws, and the board answers the same key with the message it already
  made (kept a week). A list of calls with their caller and key is a log the
  other side can replay, and the replay re-checks everything.
- **Comments are append-only.** Two sides adding comments to one ticket merge
  by putting them in time order; nothing is overwritten.
- **The state that can conflict is small**: open or closed, the latest
  decision and its status, the claim or the assignee, the moderation status,
  the edited title and body. The rules that resolve most of it already exist:
  the latest decision wins, a superseded one cannot be decided, a claim is
  refused while someone else holds the ticket.
- **The bus already relays** each client connection of B to A, and B already
  answers its own machine's calls (loops, session hosts) itself.

## Three levels

| | (a) Read copy | (b) Local writes | (c) Full replica |
|---|---|---|---|
| B holds | the projects it serves, kept up to date from A | the same | the whole board |
| Cut: reads | from the copy | from the copy | from the copy |
| Cut: writes | queued, replayed to A on return (step 1's spool) | applied on B at once, with ids from a reserved range, and replayed to A | applied on B |
| Cut: wakes | from the copy | from the copy, own writes included | from the copy |
| Return | replay the queue | replay B's writes, ids kept | replay both ways |
| Role switch | no | no | **yes** |
| Needs ids made while cut | no | yes (see below) | yes |

(a) covers the common case, reading and answering through a short cut, without
touching ids. (b) lets B's agents see their own writes and create tickets that
others can answer while cut. (c) is the only one that allows a role switch,
since B must hold everything A holds.

## How a copy is kept

Two ways, not exclusive:

- **Physical**: ship SQLite's pages (WAL shipping, as Litestream or LiteFS
  do). The copy is exact and promotion is trivial (open the file as master).
  But a copy that took writes of its own cannot be merged back: it fits a
  read copy and a planned switch, not writes on both sides.
- **Logical: an operation log.** The master records each successful write as
  an entry: a sequence number, the method, its parameters, its caller, its
  key, what it made. A replica pulls the entries after its cursor and applies
  them. Writes made on a cut replica go into its own log, and on return are
  sent to the master as calls, keys included, where they are checked like any
  call: a refusal comes back as a refusal, to the agent that made it.

**Recommended: the operation log.** It is the only one that handles writes on
both sides, and it is the bus's own unit (a method call), so it adds no second
model. The ids it carries are the master's.

## Switching the master

Two cases, of very different risk:

- **A planned switch.** A stops taking writes (its clients get a short
  "switching" refusal and spool), B applies the log to A's last entry, B
  becomes master, A becomes B's replica. No write is made on two sides, so
  there is nothing to merge. This is a human's gesture, from the web or the
  CLI, on either machine.
- **Taking over after a cut (failover).** A is unreachable; B is promoted by a
  human ("A is gone, B is master now"). If A was in fact alive and took writes
  meanwhile, there are two masters: on its return, A's writes since the split
  are replayed to B as calls (re-checked, refusals reported), and A becomes a
  replica. Ticket numbers made on both sides collide unless numbering allows
  it.

**Recommended: planned switch first; failover only as a human gesture**, never
automatic. A machine cannot tell "A is down" from "the network between us is
down", and an automatic promotion on a network cut is two masters by design.

**Where the gesture lives.** Both switches are a human's, made where the
machine's state is already shown:

- **the GNOME extension's menu**: on a proxy node it already shows the relay's
  state, and an orange icon when the parent does not answer. That menu offers
  *Take over as master* (failover) next to the state that calls for it, and
  *Hand over to …* (planned switch) on either machine. The extension talks to
  its own daemon over the Unix socket, with no token, which is enough: a
  machine promotes or demotes itself.
- **the web UI**: the Nodes panel shows which machine is master, each
  replica's lag (its cursor against the master's last entry) and the same two
  gestures, with a dialog that says what the switch does and which loops it
  restarts.
- the CLI, for a machine without either.

Each gesture is confirmed, names the machine that becomes master, and is
recorded on the board (who switched, when, from which machine).

## Tickets created while cut: ids from a reserved range

A ticket made on a node cut from the master takes its id from a range above
the master's: the highest ticket id the node's copy knows, plus an offset
(1000 for the first node, 2000 for the second…). The id is final: on return
the master inserts the ticket under it, and its own counter goes on from the
highest id it holds. Nothing is renumbered, so a `#N` quoted during the cut
stays right; the price is a gap in the numbering.

- It needs a copy that is up to date when the cut starts, so it comes with
  level (a): a node that does not know the master's last id could collide.
- Each node has its own offset, so two nodes cut at the same time do not draw
  the same ids.
- The master can still run into the range during a long cut (more tickets made
  on it than the offset). The return checks it: an id already taken is
  refused, never overwritten, and that ticket alone gets a new number, said
  to its author.
- Comments are not concerned: their ids are a separate range, and nothing
  quotes them by number.

## Conflicts on return

| Case | Resolution |
|---|---|
| Comments on the same ticket on both sides | both kept, in time order |
| Two decisions on one ticket | the latest wins, as today; the other shows superseded |
| A decision decided on one side while superseded on the other | the replay is refused; the refusal is reported to its author |
| Closed on one side, answered on the other | the answer is kept and the ticket stays closed; whether the answer should reopen it is a choice to make |
| Claimed on both sides | the first in the master's order keeps it; the other gets the usual refusal |
| Ticket created on both sides | both kept; the node's ids come from its reserved range |
| Moderation decided on both sides | the master's stands; the other is reported |

All but one (a reply landing on a ticket closed meanwhile) follow the rule a
live call already follows, applied to a replayed call.

## What the external sync (GitHub) can share

The upstream sync and a replica both reconcile the board with another source
of truth that changed meanwhile. They can share: a cursor per peer (what has
been sent, what has been seen), replay as checked calls with keys, and the
report of what was refused. They differ on what is sent: a replica sends
everything, the upstream sync only what may leave the machine.

## Order of work

1. **The spool on a proxy node goes to its parent** (a bug, today). Writes made
   during a cut reach A on return, once.
2. **The operation log on the master**: every write recorded with its sequence
   number; a replica pulls it. Nothing else changes for clients.
3. **(a) A read copy on B** fed by the log: B serves reads and wakes from it,
   cut or not; writes still go to A, or to the spool when cut.
4. **Planned switch** (needs (c): the copy covers the whole board): the human's
   gesture, A drains, B takes over, A follows.
5. **(b) Local writes while cut**, tickets numbered from the node's reserved
   range.
6. **Failover as a human gesture**, with the replay of A's writes after the
   split.
