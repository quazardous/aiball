# Replica: a proxy node that keeps working when cut from its parent, and can take its place

> **Status: built up to the planned switch** (numbers from sequences, a
> revision per document, the master's `replica.*` methods and signal, the
> node's lazy copy with the attachments' files, its background replication, its
> reads when cut, `aiball master take`, from the CLI, the GNOME extension, or
> as the Nodes panel says, with a trace on the board); local writes while cut, failover and
> the cascade are a design. This page states what a proxy node does when it loses
> its parent, how the board is copied, the choices made and the work left.

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
`spool/failed/` within a second. When A comes back nothing is replayed.
Fixed since (step 1): the node replays its spool to A when A answers again.

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

## How a copy is kept: documents, by revision

The board is copied as data, not replayed: a replica receives the rows as they
are on the master (the same ids, dates and hashids), so nothing has to be
recomputed the same way twice.

- **Two kinds of document.** A **ticket**: its row and everything about it,
  every consumer's state included (its thread, tags, payload, token usage, and
  the pings, subscriptions, wakes and credit moves about it). A **consumer**:
  its row (its live presence left out: each machine's loops report it), its
  project subscriptions, and its credit moves tied to no ticket. What each
  holds is listed once (`src/db/documents.ts`).
- **A revision per document.** When a document changes it takes the next
  number of the `rev` sequence. A ticket follows `ticketChanged`, which every
  write of a ticket's state already announces, and the writers of the rest of
  its document; a consumer, the writers of its row and its subscriptions.
- **The other tables** (projects, tags, rules, settings, sequences, uploads…)
  belong to no document: small, or only appended to, they are copied table by
  table, each with a signature a replica compares. Every table of the schema
  is placed once — in a document, among these, or left out with its reason
  (credentials, node administration, derived caches and indexes); a test fails
  on a new table placed nowhere.
- **A document goes whole**, replacing the replica's copy of it. Measured on
  the live board: 4,936 documents, 84 MB of JSON in all, 12 KB at the median,
  212 KB for the busiest ticket. (Pings sit with their ticket, not their
  recipient: as a consumer's, the most pinged one weighed 3.5 MB, sent again at
  every event.)

A replica may only lose a revision if the master dies between a write and its
revision; a per-document hash, compared now and then, catches it.

Writes made on a node cut from the master do not go into a log: they are
spooled as method calls and replayed to the master when it answers again,
checked like any call, and come back through the revision of what they changed.

## Transport: the master signals, the replica pulls

A replica must keep up without loading either machine, idle or catching up.

- **The master pushes a signal**, never the data: `replica_rev`, its last
  revision, on the link a node already keeps open to its parent (the WebSocket
  of its heartbeat and its sessions), at most once a second, and in the hello
  of each connection. Nothing is sent while nothing is written.
- **The replica pulls** the documents revised after its cursor
  (`replica.pull`), 500 at most a time, at its own pace, and the board tables
  whose signature moved (`replica.board`). The master keeps nothing per
  replica.
- **A lost signal costs nothing**: the next one, or the next hello, catches up.
- **Catching up after a cut** is the same path, from an older cursor.
- **A new node** starts from 0: every document and every board table. Its
  order can be chosen (the projects it serves first, then open and recent
  tickets), and it is usable before the end; a snapshot of the database is
  the faster start for a large board.

Pushing everything would make the master queue for each cut replica, without
bound during a long cut, and track acknowledgements. Pulling alone means
choosing between latency and idle calls (one a second is 86,400 a day for
nothing).

## Cascade: a replica of a replica

A replica can serve replicas of its own, so nodes chain (A ← B ← C):

- **Down the chain, the documents are relayed as they are.** B pulls from A
  and serves the same documents, under A's revisions, to C; B's signal to C
  follows its own pull. C never talks to A, and nothing is renumbered on the way.
- **Up the chain, a write goes hop by hop.** C's write goes to B, which relays
  it to A, as a proxy node does today; cut at any hop, it waits in the spool of
  the machine below the cut, and goes up when that hop answers again.
- **A cut in the middle** leaves the machines below it on their copies: C
  reads from its copy, B from its own, each as far as its cursor goes.
- **Each machine knows only its parent and its children**: its upstream to
  pull from and write to, its downstream to signal. Retention on B counts C's
  cursor, as A's counts B's.
- **Switching the master in a chain** re-points one link at a time: when B
  becomes master, A becomes B's replica, and C keeps B as its parent. Taking
  over from a machine in the middle of a chain is the same human gesture,
  made on that machine.
- **A node's id range** (above) is taken per machine, wherever it sits in the
  chain.

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
  state, and an orange icon when the parent does not answer. The planned switch
  is there (built, see below); *Take over as master* (failover) would sit next
  to the state that calls for it. The extension runs its own machine's CLI, with
  no token, which is enough: a machine promotes or demotes itself.
- **the web UI**: the Nodes panel shows which machine is master, each
  node's copy and whether it can take over (built); the failover gesture would
  join it.
- the CLI, for a machine without either.

Each gesture is confirmed, names the machine that becomes master, and is
recorded on the board (who switched, when, from which machine).

## Numbers: sequences, and ranges reserved to nodes

Ticket and message numbers come from sequences (`src/db/sequences.ts`): one
row per sequence and its next number. A sequence checks its next number
before handing it out: one that lies in a range reserved to a node, or that a
row already has (brought by a sync), is refused, naming the conflict, and the
counter does not move. A number is never skipped over silently, nor written
over.

A ticket made on a node cut from the master will take its number from a range
reserved to that node, far above the master's (1000 for the first node, 2000
for the second…). The number is final: on return the master inserts the
ticket under it. Nothing is renumbered, so a `#N` quoted during the cut stays
right; the price is a gap in the numbering. Each node has its own range, so
two nodes cut at the same time do not draw the same numbers.

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

## The node's copy: lazy, ticket by ticket

The node stays a proxy: while its master answers, every call is relayed. Its
copy is beside, in its own database:

- **Lazily**: a ticket the node relays a read of (`ticket.get`) is kept from
  then on, with the board's small tables.
- **Kept up to date**: at each `replica_rev`, the node asks what changed since
  its cursor (`replica.changes`, headers only) and takes again the documents it
  keeps (`replica.docs`), no other.
- **In the background, quietly**, the rest of the board, until the node has it
  all (the projects it already keeps tickets of first, the most recent first;
  small batches, a rest between them, stepping aside while its clients are at
  work and on battery; resumed where it stopped). Complete, the node takes
  every change.
- **Cut from its master**, the node serves its clients' connections itself: the
  reads of a fixed list answer from its copy; a write is refused as
  unavailable (503), and the client queues it for the master. Its `bus.hello`
  says so (`replica: { cut, complete, as_of }`). Nothing is written to the copy
  while cut; on return, the spool goes up first, then the copy catches up.
- **Visible**: `/api/node` on the node, its master's Nodes panel ("copy 120/4936",
  "copy complete") and the GNOME extension's state line.

The copy is written with its foreign keys unchecked: a ticket kept may name one
that is not (its parent, a relation), as a partial copy must allow.

## Switching the master: `aiball master take`

Made on the node (B) that takes the board over from its master (A):

```
aiball master take --url http://B:7777     # where A reaches B from then on
```

1. **Conditions**, each said when it fails: B's copy is complete (every
   document and every attachment's file); the link between them is https, a
   tailnet address or the same machine (A's tokens will cross it); no other node
   is connected to A (it would need the cascade).
2. **A stops taking writes**: they answer 503 `SWITCHING` and their clients
   queue them; reads still answer. A's own periodic board writes stop too.
3. **B catches up** to A's last revision, takes A's revisions and tokens whole,
   and checks it holds what A holds (counts, board signatures). A mismatch
   aborts: A takes writes again, nothing has changed.
4. **The point of no return**: B mints a node token for A; A writes its
   `proxy:` block towards B and a complete `replica.json`; B drops its own
   `proxy:` block. Both restart (`--no-restart` leaves it to you), and each
   machine's loops with them.

A's address keeps serving the board, relayed to B: tvty, a phone, A's tailnet
URL need no change. Writes queued during the switch go up to B from A's spool.

**Where the gesture is.** The same gesture, wherever the machine's state shows:

- **the GNOME extension** on the node: *Take the board over (become the
  master)*. Greyed out while the node is not ready, with the first reason (the
  copy is not complete, the link is not https or a tailnet, the master is out of
  reach, no URL where the master would reach this machine). The URL is the one
  Tailscale serves this board on. A confirmation says what restarts, then it
  runs `aiball master take`, and its answer is a notification.
- **the Nodes panel** on the master: which machine is the master, and for each
  node whether it can take over, or why not (what the node says through its
  `/api/node` and its pushed progress, plus the other nodes connected to the
  master). The gesture stays on the node: the panel says where to make it.
- **the CLI**, for a machine without either.

**The trace.** Each switch is written once, by the new master, at the point of
no return: from which machine to which (and their URLs), when, by whom, at which
revision. It is a board table, so every node keeps it too; the Nodes panel
lists the latest. A switch that is refused or aborted leaves none.

## Order of work

1. **The spool on a proxy node goes to its parent** (done). Writes made during
   a cut reach A on return, once.
2. **The master's side** (done): sequences, a revision per document,
   `replica.pull` and `replica.board`, the signal to nodes.
3. **A copy on B** (done): lazy, ticket by ticket, then the rest in the
   background; reads served from it when cut, writes spooled.
4. **Planned switch** (done): `aiball master take`, A drains, B takes over,
   A follows; the same gesture in the GNOME extension, each node's readiness
   in the Nodes panel, and each switch traced on the board.
5. **Local writes while cut**, tickets numbered from the node's reserved range.
6. **Failover as a human gesture**, with the replay of A's writes after the
   split.
