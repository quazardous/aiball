# The bus

> **Status: every client is on it.** Calls, batches, subscriptions and
> revocation are in place, and every operation of the board is a method (see
> *Methods*). The web UI, the MCP server, the CLI, claude-loop and tvty call
> them over the bus. The HTTP routes that served them are gone; what HTTP
> still does is listed below.

The bus is how a client talks to aiball: **one permanent connection** per
client, JSON-RPC 2.0 over a WebSocket. The core is a table of **methods**,
functions of the caller and their parameters; the bus calls them directly.
HTTP stays for what a browser fetches by URL: the web UI's files, and uploaded
files; for logging in; for the intake a script posts to with a key (a ticket,
a signal), a node's pairing, and the project list the GNOME indicator reads.
It also stays for the probes that answer for the daemon you reach and
need no token: `/api/health`, `/api/node`, `/api/version` and
`/api/auth/status`. A proxy node answers these itself, where the bus would
relay the question upstream.

## Connecting

The WebSocket is at **`/bus`**:

- on the local socket (`~/.local/share/aiball/sock`): the same trust as `/api`
  there, the same user, no token. Who you are is the `x-aiball-consumer`
  header, `human` without it;
- over TCP: a token, as for `/api` — `Authorization: Bearer <token>`, or
  `?token=` where headers cannot be set (a browser);
- over TCP **from this machine** (the loopback), the **machine secret** read
  from `<AIBALL_HOME>/machine-secret` as the bearer: the socket's trust, where
  there is no socket (Windows). Who you are is the `x-aiball-consumer` header
  again, `human` without it, and the methods that act on this machine accept
  you ([`SECURITY.md`](./SECURITY.md)).

**Through a proxy node** ([`REMOTE.md`](./REMOTE.md)), `/bus` is on the node's
socket and port too: the node relays each connection to its upstream's `/bus`,
one upstream connection each, opened as it relays `/api` (the caller's own
token when it has one; otherwise the node token and the consumer named — never
in strict mode). Messages pass as they are; the `bus.hello` is the upstream's;
either side closing closes the other. The upstream sees the caller relayed
(see *Who may call a method*).

The methods that act on **a machine** — its loops (`loop.*`, `consumer.afk`), its
session hosts (`session.*`), its folders (`project.init`, `project.settings`,
`project.settings_set`) and the daemon itself (`daemon.info`, `daemon.reload`) — are
not relayed: the node answers them, for its own machine, as the caller the
upstream's `bus.hello` names (its kind included). They are marked *this machine's*
in the tables below. The upstream refuses them to a relayed caller: they would act
on the upstream's machine. A batch goes one way whole; one that mixes this
machine's methods with the board's is refused, call by call. The same goes for a subject
about the machine (`session.<name>.state`): a node serves the subscription itself,
from its own sessions, and its events arrive on the same connection as the board's;
its end (`bus.unsubscribe`) goes where it lives. Such a subscription carries the
node's own epoch and `seq`, not the upstream's.

The loop controls that reach a loop through its bus connection
(`consumer.stop_loop`, `consumer.prompt`, `consumer.restart_claude`) are answered by
a node when the loop runs on its machine (a plate there names the agent): the node
sends the control on the loop's socket, and asks the loop itself whether Claude is
idle. For any other loop they are relayed, and the upstream refuses them to a relayed
caller, as the node's token could name anyone.

### Machines

Where something runs is said in one vocabulary: `hub` (the daemon that holds the
board), `node:<label>` (a proxy node), `tcp:<address>` (a client reaching the hub
directly over TCP). It names where a consumer's loop is connected from
(`machine` in `consumer.list` and `agent.<id>.state`, null without a loop), which
machine holds a session (`machine` in a consumer's `session` and in
`session.list`), and where the caller is (`machine` in `bus.whoami`).

A client takes for its own what runs on **its** machine: the consumers and the
sessions whose `machine` is the one `bus.whoami` answers. A session is attachable
from its machine only: its socket, or its tmux session, is there. Behind a node,
a consumer's `session` comes from the hub and is empty for the node's own agents:
the node's sessions are read in `session.list` and `session.<name>.state`, which
the node serves for its machine. Each row there carries `agent` (null for a
session without one), `machine` and what attaches it (`attach.socket`), so a
client joins it to its agent by `agent`. A consumer's
`remote` is older and says something else: whether the consumer was last seen
from outside **the hub's** machine. Behind a node it reads the wrong way round
(the hub's agents `false`, the node's own `true`); compare `machine` instead.

The caller is authenticated **once**, on this opening request, by the same code
as an HTTP request, and every call on the connection runs as that caller. An
opening that fails is answered in HTTP with `{ error, code }` (401
`AUTH_REQUIRED` or `TOKEN_INVALID`, 403), and no connection is made.

The daemon's first message is a notification:

```json
{ "jsonrpc": "2.0", "method": "bus.hello",
  "params": { "version": 1, "epoch": "…", "consumer": "claude-aiball-dev", "kind": "agent", "relayed": false } }
```

`epoch` changes when the daemon restarts (see *Subscriptions*).

`kind` and `relayed` say what kind of caller the connection is (see *Who may
call a method*).

## Calls

A text frame holds one JSON-RPC 2.0 message, or a batch of them:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "bus.whoami", "params": {} }
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "consumer": "claude-aiball-dev", "kind": "agent", "relayed": false, "transport": "uds", "machine": "hub" } }
```

- A message without `id` is a notification: it runs, and gets no answer.
- Frames on one connection are answered **in the order they came**: a read sent
  after a write sees it.
- A frame is at most 4 MiB; a larger one closes the connection (1009).

**Batches.** An array of calls (at most 100) runs in order and is answered in
one frame, an array of the answers (notifications left out). Each call settles
on its own: one refused does not stop the others.

## Errors

A method's refusal carries an HTTP status and an error code: its JSON-RPC
`code` is the status, and `data.code` is aiball's error code
([`API-ERRORS.md`](./API-ERRORS.md)), which is what a client reacts on.

```json
{ "jsonrpc": "2.0", "id": 4, "error": { "code": 409, "message": "…",
  "data": { "code": "TICKET_HELD", "status": 409, "details": { } } } }
```

A message the bus could not run gets JSON-RPC's own code, and `data.code` too:

| `code` | When | `data.code` |
|---|---|---|
| -32700 | the frame is not JSON | `BAD_REQUEST` |
| -32600 | not a JSON-RPC 2.0 request; an empty batch, or one over 100 | `BAD_REQUEST` |
| -32601 | no such method | `NOT_FOUND` |
| -32602 | invalid params; `data.details.issues` says which | `BAD_REQUEST` |
| -32603 | the method failed; the details stay in the daemon's journal | `INTERNAL` |

## Subscriptions

A client subscribes to a **subject** and gets its current value, then every
change **as data** — never a signal to go and read it again.

- **`bus.subscribe {subject, since?, …}`** answers
  `{ id, subject, seq, epoch, replayed, value | events }`.
- Then **`bus.event`** notifications: `{ subscription, subject, seq, data }`.
- **`bus.unsubscribe {id}`**. Closing the connection ends its subscriptions.

**Order and catching up.** `seq` is one counter for the whole daemon, always
increasing: events reach a client in `seq` order. A client that reconnects
passes `since: {epoch, seq}` — the daemon's epoch and the last `seq` it
received. If the daemon still holds everything after it (the latest 4096
events, and the same epoch), the answer is `replayed: true` with the missed
`events`, in order, and no `value`; otherwise `replayed: false` and the
`value`, whole.

| Subject | `value` | an event's `data` | Who |
|---|---|---|---|
| `agent.<id>.bar` | the bar, as `consumer.bar` returns it, or `null` | the bar | a human, or the agent itself |
| `agent.<id>.state` | the entry `consumer.list` gives | the whole entry again, built by the same code, whenever it changed (presence, loop state, pings, credit, `session`, an agent's `counters`); `null` once the consumer is deleted | humans and agents |
| `project.<p>.tickets` | the rows `inbox.list` gives with `view: "turn"`; options `open`, `include_postponed` | `{ op: "upsert", row }` or `{ op: "remove", id, project }` | humans and agents; the rows are the subscriber's |
| `ticket.<id>` | what `ticket.get` gives with `full: true` | `{ type, message }`: `message_created`, `_edited`, `_decided`, `_noted`, `_tagged` | humans and agents |
| `user.<id>.pings` | `{ unread }` | a ping, as the event stream carries it, and `message`: what it points at (`id`, `hashid`, `kind`, `status`, `by_agent`, `created_at`, `project`, `ticket_id`, `title`, `decision`) | oneself |
| `session.<name>.state` | a session without an agent, as `session.list` gives it, or `null` | `{ name, session }`: started, clients, exited, and `session: null` once stopped | humans and agents; this machine's |
| `loop.<name>.state` | the loop as `loop.list` shows it, or `null`; with `*`, keyed by loop name | the whole view again whenever it changed (it appeared, started, stopped, changed mode, clients, model, was superseded); `null` once the loop is forgotten (`rm`). Recomputed while subscribed, on the plates and the board's events, and every 30 s for a tmux session killed silently | humans, local only, this machine's |
| `agent.<id>.backlog` | `{ project, backlog: [{ id, tier, cooled_until }] }`, the agent's backlog as its picker sees it | `{ project, changed: [ids] }`: the tickets whose place changed — sunk by a backlog wake, out of their rest, another tier, in or out. Kept only while subscribed, for an agent with no loop too | humans and agents |
| `agent.<id>.events` | `{ consumer_id, unread, counters }` | `{ event, data }`: a `ping` (not one outside the wake focus), a loop `control` (`kill`, `prompt`, `restart_claude`), a `signal`, its `counters` when a number changed; the waiting signals and spooled prompts come right after the answer; the subscription is the loop's liveness; never replayed. Opening it (with `backlog_cooldown_sec`, the rest its backlog applies after a backlog wake) is where the loop states it for `consumer.backlog` and the counters, and the agent's standing (`x-aiball-role`, `x-aiball-no-claim` on its row); a second loop under the agent from another machine is refused (`CONFLICT`) | the loop itself |
| `board.events` | `null` | every event the board broadcasts, `{ type, data }`, the feed the web UI patches its views from; `project_standing_changed` carries a project's `project.standing_prompt` answer after each change of its standing prompt or wake focus (a focus that runs out on its own date sends nothing) | humans and agents |
| `config.changed` | `null` (`config.managed` is the whole read) | `{ op: "set" \| "clear", key, project, value, by }` on each `config.set` / `config.clear`; `{ op: "reload" }` after a config file was reloaded: read `config.managed` again | humans and agents |
| `agent.<id>.screen` | `{ source }`: `host`, `tmux` or `node`; `null` when it cannot be followed | from the session host, `snapshot` (bytes that repaint the screen, base64, after a reset, with the `size`) then `output` (Claude's output as it comes, base64) and `size`; from tmux or a node, `frame` (the whole visible pane as text, with `cursor` and `geometry`) when it changed; `error` (passing), `unavailable` (why nothing more comes). Options `typing` (on the host, an interactive client: it may type, and takes the size once it does) and `size` (the size it would like). Never replayed: a new subscription gets a fresh snapshot | humans |

`*` stands for one level: `agent.*.bar`, `agent.*.state` and
`project.*.tickets` give every agent's or project's, including the ones
created after the subscription, with a `value` keyed by agent or project
(every bar is a human's view). Each event names its own subject:
`agent.worker.bar`, `project.aiball.tickets`.

**A view's rows.** A `project.<p>.tickets` row is built by the same code as
`inbox.list`'s, for the subscriber, and pushed only when it changed. Some of
its fields change with time alone — `hot` cooling, a step going stale, a claim's
hold or a snooze ending — and the daemon pushes the row at that moment: a
client never has to read the list again. A ticket that leaves the view (closed
in an `open` view, moved to another project) comes as a `remove`. The view is
always sent whole again on `since`: the rows it held could have left it while
the client was away.

## Who may call a method

Every method declares the kinds of caller it admits, and the bus checks it
before running it (403 otherwise; `MODERATOR_ONLY` for a human's gesture):

| Kind | Who |
|---|---|
| `human` | a human |
| `agent` | an agent |
| `key` | an API key; the method also names the scope the key needs (403 `KEY_SCOPE_MISSING` without it) |

**Relayed.** A caller that comes through a proxy node is the consumer the node
names, with `relayed: true`. The node's token is the weak point
([`SECURITY.md`](./SECURITY.md)): a method that must not be reached that way
(the loop controls through the board: `consumer.stop_loop`, `consumer.prompt`,
`consumer.restart_claude`, the all-loops gestures) refuses a relayed caller, whoever
it names.

## Revocation

The connection rests on the identity settled when it opened. When the token
under it is revoked (a logout, a node revoked, a key deleted) or expires, the
daemon closes the connection with code **4001**. A token deleted outside the
daemon (by the CLI) is caught by the keepalive check, within 25 seconds. A
connection on the local socket rests on no token.

Other close codes: **4002**, the client did not read what it was sent (more
than 8 MiB waiting); 1003, a binary frame.

## Keepalive

The daemon pings every 25 seconds; a client that has not answered by the next
ping is cut. WebSocket libraries answer pings on their own.

## The contract, generated

The methods are published as an OpenRPC document and the subjects as an
AsyncAPI one, both generated from the code (the methods' params from their
schemas, their descriptions from the comments above them):
[`api-bus.openrpc.json`](./api-bus.openrpc.json) and
[`api-bus.asyncapi.json`](./api-bus.asyncapi.json), served live by
`rpc.discover` and `bus.subjects`. `npx tsx scripts/bus-contract.ts` rewrites
them; a test fails when they are stale.

## Methods

Parameters are the fields the HTTP route took, when there was one — its path,
query and body fields, under the same names — as one object; a yes/no flag is
a boolean, and "1" is accepted too. Results are what the route answered.

| Method | Callers | Replaces |
|---|---|---|
| `bus.whoami` | human, agent | — who the connection runs as: `{ consumer, kind, relayed, transport, machine }`; `machine` is where the caller is (see *Machines*) |
| `rpc.discover` | human, agent | — this bus's methods, as OpenRPC |
| `bus.subjects` | human, agent | — this bus's subjects, as AsyncAPI |
| `bus.subscribe` | human, agent | — see *Subscriptions* |
| `bus.unsubscribe` | human, agent | — see *Subscriptions* |
| `session.start` | human, this machine's | — a session on this machine ([`SESSION-HOST.md`](./SESSION-HOST.md)); `HOST_BUSY`. An agent's loop runs where `mode` says (`host` or `tmux`); without it, where its start decides, as from a terminal (the folder's `claude_loop.session`, tmux for a folder bound to a remote daemon), and the answer says where it came up. In tmux it answers `{ agent, host: "tmux", tmux }`: `tmux` is the session to attach. `remote_control` (`true`, `false` or a name) starts Claude with Remote Control or without, over the project's `claude.remote_control`; the loop keeps it for its restarts |
| `session.stop` | human; an agent its own session, locally (its loop's `rm`); this machine's | — ends a session and its host |
| `loop.list` | human, local only, this machine's | — the loops of this machine, stopped ones included, from their plates: `{ name, cwd, agent, project, role, mode: host\|tmux, running, remote_control, model, tmux?, attach?, clients, interactive, started_at, last_seen_at, superseded }`; `remote_control` is what Claude started with: `false`, or the session's name; `model` is the running loop's, as its bar says (`{ id, name }`, else null); `started_at` is when the loop last started, `last_seen_at` when its log was last written (null when it has none); `superseded` marks a stopped loop whose agent has a loop that runs, or a later one — the one to show is the other; `clients` / `interactive` are the clients attached to a loop that runs and those with the controls (null when stopped or not said yet) |
| `loop.clients_readonly` | human, local only, this machine's | — `{ name }` or `{ agent }`, `keep_pid?`: every other client of a loop in tmux (all but the one whose process is `keep_pid`, the client taking the controls) becomes a read-only copy, which shows the COPY mark; answers `{ name, clients, interactive }`. A loop on the session host is refused (`CONFLICT`): its clients take the controls there |
| `loop.clients_detach` | human, local only, this machine's | — the same, detaching those clients instead |
| `loop.restart` | human, local only, this machine's | — restarts a loop from its plate, its conversation resumed (`fresh`: a fresh one): where it ran, or in `mode` to move it between the session host and tmux; answers its `loop.list` view once it is back. A running loop whose Claude works is refused (`NOT_IDLE`) unless `force`. `remote_control` changes Claude's Remote Control for this start and the next; without it the loop keeps its own |
| `loop.wake` | human, local only, this machine's | — wakes a loop now, as `claude-loop wake` does: it tries a wake at its next heartbeat for the events waiting, without waiting for its tempo; `{ name, requested: true }`. A loop that does not run is `LOOP_NOT_FOUND`; a loop whose Claude works is refused (`NOT_IDLE`) unless `force` |
| `session.list` | human, agent, this machine's | — every session this daemon hosts |
| `inbox.list` | human, agent | `GET /api/inbox` — the result is `{ total, rows }`: the rows (with `view: "turn"`, the pilot's fields; see [`API-INBOX.md`](./API-INBOX.md)) and the count HTTP sends as `X-Total-Count` |
| `ticket.get` | human, agent | `GET /api/tickets/:id` — flags (`full`, `brief`, `digest`, `include_deleted`) are booleans |
| `tag.list` | human, agent | `GET /api/tags` |
| `project.milestones` | human, agent | `GET /api/projects/:project/milestones` |
| `mention.suggestions` | human, agent | `GET /api/mention-suggestions` |
| `consumer.list` | human, agent | `GET /api/consumers` |
| `consumer.backlog` | human, or the agent itself | `GET /api/consumers/:consumer_id/backlog` |
| `consumer.bar` | human, or the agent itself | `GET /api/consumers/:consumer_id/bar` |
| `consumer.set_bar_host` | human, not relayed | `POST /api/consumers/:consumer_id/bar-host` |
| `consumer.afk` | human, this machine's | `POST /api/agents/:name/afk` |
| `consumer.restart_claude` | human; through a proxy node, only for a loop of its machine | — restarts an agent's Claude after it installed an update (its bar's `alerts.restart_needed`): refused `NOT_IDLE` while Claude works, unless `when_idle`: then the loop holds the order until Claude's next idle, however long, its bar says `alerts.restart_pending` meanwhile, and a second order changes nothing; the loop resumes the conversation and tells the agent once it is back |
| `consumer.counters` | human, or the agent itself | — an agent's counters computed now: `open`, `actionable`, `backlog` (cooled-down threads left out), `events` (unread pings), `wakes` (those of them that wake it: not a ticket another agent holds); a changed number is pushed on `agent.<id>.state` too. The daemon computes them on the events that move them (a ticket's lifecycle, a ping written or read); this is for what moves with time alone |
| `agent.pane_keys` | human | `POST /api/agents/:name/pane/keys` — on the session host, through the caller's `agent.<id>.screen` opened with `typing` (`CONFLICT` without one); in tmux or on a node, straight to the pane |
| `agent.pane_resize` | human | — the size a typing viewer would like, for a session on the host; applied while it owns the size |
| `message.get` | human, agent | `GET /api/messages/:id` |
| `message.post` | human, agent | `POST /api/messages` — the params are the message |
| `message.decide` | human, agent | `POST /api/messages/:id/decide` |
| `message.approve` | human, agent | `POST /api/messages/:id/approve` |
| `message.reject` | human, agent | `POST /api/messages/:id/reject` |
| `message.accept_and_close` | human, agent | `POST /api/messages/:id/accept-and-close` — a close that fails after the accept is a 500 whose `data.details.approved` is the accepted decision |
| `message.edit` | human, agent; a ticket's level, human | `POST /api/messages/:id/edit` |
| `message.step` | human | `POST /api/messages/:id/step` |
| `message.unstep` | human | `POST /api/messages/:id/unstep` |
| `message.delete` | human | `POST /api/messages/:id/delete` |
| `message.answer_question` | human, agent | `POST /api/messages/:id/questions/:qid/answer` |
| `message.resurface` | human | `POST /api/messages/:id/resurface` |
| `message.summarize` | human, agent | `POST /api/messages/:id/summarize` |
| `message.vote` | human, agent | `POST /api/messages/:id/vote` |
| `message.reclassify` | human, agent | `POST /api/messages/:id/reclassify` |
| `message.promote` | human, agent | `POST /api/messages/:id/promote` |
| `message.untag` | human, agent | `POST /api/messages/:id/untag` |
| `message.note` | human, agent | `POST /api/messages/:id/note` |
| `message.add_tag` | human, agent | `POST /api/messages/:id/tags` |
| `message.remove_tag` | human, agent | `DELETE /api/messages/:id/tags/:tag` |
| `ticket.assign` | human, agent; pushing to another, human | `POST /api/tickets/:id/assign` |
| `ticket.relate` | human, a reporter or project-owner of either ticket, or its assignee (depends_on / blocks) | `POST /api/tickets/:id/relations` |
| `ticket.set_owner` | human | `POST /api/tickets/:id/owner` |
| `ticket.release` | human, agent | `POST /api/tickets/:id/release` |
| `ticket.mark_read` | human, agent | `POST /api/tickets/:id/mark-read` |
| `ticket.postpone` | human | `POST /api/tickets/:id/postpone` |
| `ticket.unsnooze` | human | `POST /api/tickets/:id/unsnooze` |
| `ticket.move` | human, or the reporter | `POST /api/tickets/:id/move` |
| `ticket.set_milestone` | human, or a cto agent | `POST /api/tickets/:id/milestone` |
| `unread.list` | human, agent | `GET /api/unread` — `consumer_id` left out is the caller; `for: "wake"` keeps only what may wake the consumer's loop (a ticket assigned to another agent is unread, not a wake, unless it names the consumer or the consumer follows it) |
| `unread.count` | human, agent | `GET /api/unread/count` |
| `unread.mark_read` | human, agent; another consumer's backlog or `delete`, human | `POST /api/mark-read` |
| `message.pending_count` | human, agent | `GET /api/my-pending/count` — `by_agent` left out is the caller |
| `consumer.micro_status` | human, agent | `GET /api/micro-status` |
| `ping.list` | human, agent | `GET /api/pings` |
| `ping.count` | human, agent | `GET /api/pings/count` — `for: "wake"` counts only what may wake the consumer's loop. A ping event (`user.<id>.pings`, the loop's stream) says `wakes: false` when it does not |
| `ping.mark_read` | human, agent | `POST /api/pings/mark-read` |
| `backlog.record_wake` | human, agent | `POST /api/backlog-wake` |
| `ticket.list` | human, agent | `GET /api/tickets` — the filters are the query's fields; a yes/no may be a boolean |
| `message.search` | human, agent | `GET /api/search` |
| `graph.neighbors` | human, agent | `GET /api/graph/neighbors` |
| `graph.audit` | human, agent | `GET /api/graph/audit` |
| `decision.mine` | human, agent | `GET /api/decisions/mine` |
| `decision.plans_to_execute` | human, agent | `GET /api/decisions/plans-to-execute` |
| `project.subscribe` | human, agent | `POST /api/subscriptions` — `consumer_id` left out is the caller |
| `project.subscriptions` | human, agent | `GET /api/subscriptions` |
| `project.unsubscribe` | human, agent | `DELETE /api/subscriptions` |
| `ticket.subscriptions` | human, agent | `GET /api/ticket-subscriptions` |
| `ticket.subscribe` | human, agent | `POST /api/ticket-subscriptions` |
| `ticket.subscription` | human, agent | `GET /api/ticket-subscriptions/:ticket_id` |
| `ticket.unsubscribe` | human, agent | `DELETE /api/ticket-subscriptions/:ticket_id` |
| `project.list` | human, agent | `GET /api/projects` — `detailed`, `landscape` are booleans; a detailed row also carries `standing_prompt`, `focus_active`, `focus_line` |
| `project.create` | human, agent | `POST /api/projects` |
| `project.stats` | human, agent | `GET /api/projects/:name/stats` |
| `project.standing_prompt` | human, agent | `GET /api/projects/:project/standing-prompt` |
| `project.critical` | human, agent | `GET /api/projects/:project/critical` |
| `project.rename` | human, agent | `POST /api/projects/:name/rename` |
| `project.delete` | human, agent | `DELETE /api/projects/:name` |
| `project.add_token_usage` | human, agent | `POST /api/projects/:project/token-usage` |
| `project.init` | human, local only, this machine's | — sets a folder up as a project, as `claude-loop init` does: its `.mcp.json` and `.aiball.yaml` (`cwd`, `project`, `agent`, `role`, `private`, `no_claim`, `force`, `dry_run`); answers each file's step (`created`, `added`, `patched`, `overwrote`, `kept`…), whether the project is already on the board, and whether the aiball skill is installed. Refusals: a folder absent (`NOT_FOUND`), not writable (`FORBIDDEN`), a malformed name (`BAD_REQUEST`), a file there that cannot be parsed (`CONFLICT`) |
| `project.settings` | human, local only, this machine's | — the settings a client may show for a folder's project (`cwd`), as a loop started there would get them, each value with where it comes from: `{ file, configured, consumer: { project, agent, role }, session, remote_control, questions }`, each field `{ value, from }` (`from`: `file`, `global` for `session` and `questions`, `mcp` or `env` for the identity, else `default`); and `settings`, the settings a client may change here described as `config.managed` describes its keys (`{ key, type: enum\|boolean_or_name, options?, default, value, from, label, description }`), so a key added later shows with no client code; `file` is the `.aiball.yaml` that loop reads (the nearest one up the tree), null without one (`configured` false) |
| `project.settings_set` | human, local only, this machine's | — changes them in that `.aiball.yaml`, patched in place (its other keys and comments stay): `remote_control` true, false or a name, `session` `host` or `tmux`, `null` to remove either (the layer below applies again), or any described setting as `{ key, value }` (`BAD_REQUEST` for an unknown key or a value its type does not take); a file left with no key keeps its leading comments only, never `{}`; answers as `project.settings`. The next start reads it. Refusals: a folder absent (`NOT_FOUND`), no `.aiball.yaml` to patch (`CONFLICT`: `project.init` first), a file that cannot be parsed (`CONFLICT`), not writable (`FORBIDDEN`) |
| `consumer.presence` | human, agent | `GET /api/presence` |
| `consumer.get` | human, agent | `GET /api/consumers/:consumer_id` |
| `consumer.push_state` | agent, its own | `PUT /api/consumers/:consumer_id/state` |
| `consumer.push_clients` | agent, its own | — a tmux loop says who is attached to its session, `{ clients, interactive }` (those with the controls); a change is broadcast as `consumer_changed { session }`. A session's `clients` / `interactive` come from it in tmux, from the host on the host (null before either said). A client attached counts itself: another holds the loop when `clients` > 1 once attached |
| `consumer.push_bar` | agent, its own | `PUT /api/consumers/:consumer_id/bar` — on the bus the bar is `bar`; over HTTP it is the whole body |
| `ticket.add_token_usage` | human, agent | `POST /api/tickets/:id/token-usage` |
| `message.list` | human, agent | `GET /api/messages` — `summary`, `open` are booleans |
| `ticket.bookends` | human, agent | `GET /api/tickets/bookends` |
| `session.host` | human or agent, local only, this machine's | — `claude-loop start --host` runs its prepared command in the agent's session on this daemon's host; the answer carries `control`, the socket the kernel drives |
| `ticket.payload` | human, agent | `GET /api/tickets/:id/payload` |
| `ticket.set_payload` | the reporter, the assignee, a human | `PUT /api/tickets/:id/payload` |
| `ticket.dump_payload` | the reporter, the assignee, a human | `POST /api/tickets/:id/payload/dump` — a closed ticket (409) or a revoked payload (410) says which in `details.access` |
| `ticket.revoke_payload` | the reporter, the assignee, a human | `DELETE /api/tickets/:id/payload` |
| `ticket.pending_children` | human, agent | `GET /api/tickets/:id/pending-children` |
| `ticket.approve_pending_children` | human | `POST /api/tickets/:id/approve-pending-children` |
| `signal.list` | human, agent; another consumer's, human | `GET /api/signals` |
| `signal.ack` | human, agent | `POST /api/signals/:id/ack` |
| `project.feed_path` | human, agent | `GET /api/feed-path` |
| `message.set_tags` | human, agent | `PUT /api/messages/:id/tags` — replaces the set; `tag_ids` takes ids or names |
| `automation.rules` | human, agent | `GET /api/automation/rules` — `enabled_only` is a boolean |
| `automation.create_rule` | human, agent | `POST /api/automation/rules` |
| `automation.update_rule` | human, agent | `PATCH /api/automation/rules/:id` |
| `automation.delete_rule` | human, agent | `DELETE /api/automation/rules/:id` — 204 over HTTP; a rule from the YAML config is refused |
| `consumer.upsert` | human, agent | `POST /api/consumers` |
| `consumer.update` | human, agent; the capability fields, human | `PATCH /api/consumers/:consumer_id` |
| `config.get` | human, agent | `GET /api/config` |
| `step.timing` | human, agent | `GET /api/steps/timing` |
| `ticket.import` | human, agent | `POST /api/tickets/import` — an issue a ticket already mirrors is a 409 whose `details.existing_ticket_id` names it |
| `ticket.export` | human, agent | `POST /api/tickets/:id/export` — same 409 |
| `daemon.reload` | human or agent, local only, this machine's | `POST /api/daemon/reload` |
| `daemon.info` | human, agent, this machine's | — where the web UI answers: `{ version, web_url, public_url }`; `web_url` is the address the daemon listens on (a wildcard bind on loopback), `public_url` the tailscale serve its config declares, null without one |
| `strategy.get` | human, agent | `GET /api/strategy` |
| `strategy.set` | human, agent | `PATCH /api/strategy` |
| `project.strategy` | human, agent | `GET /api/projects/:project/strategy` |
| `project.set_strategy` | human, agent | `PATCH /api/projects/:project/strategy` — null clears the project's own |
| `project.set_standing_prompt` | human, agent | `PATCH /api/projects/:project/standing-prompt` — the prompt, the wake focus, or both |
| `project.stats_rich` | human, agent | `GET /api/projects/:name/stats-rich` |
| `project.purge` | human, agent | `POST /api/projects/:name/purge` |
| `board.purge` | human, agent | `POST /api/tickets/purge` — every project |
| `board.info` | human, agent | `GET /api/info` |
| `token_usage.timeseries` | human, agent | `GET /api/token-usage/timeseries` |
| `config.managed` | human, agent | `GET /api/managed-config` |
| `config.set` | human, agent; a protected key, human | `PUT /api/managed-config/:key` |
| `config.clear` | human, agent; a protected key, human | `DELETE /api/managed-config/:key` — 204 over HTTP |
| `tag.create` | human, agent | `POST /api/tags` |
| `tag.override` | human, agent | `PUT /api/tags/override` — a config tag's color and order |
| `tag.update` | human, agent | `PATCH /api/tags/:id` |
| `tag.delete` | human, agent | `DELETE /api/tags/:id` — 204 over HTTP |
| `consumer.me` | human, agent | `GET /api/me` |
| `ticket.mark_unread` | human, agent | `POST /api/tickets/:id/mark-unread` |
| `ticket.subscribers` | human | `GET /api/tickets/:id/subscriptions` — a ticket's follows and mutes |
| `ticket.step` | human | `POST /api/tickets/:id/step` |
| `ticket.unstep` | human | `POST /api/tickets/:id/unstep` |
| `consumer.wait_credit` | human, agent | `GET /api/consumers/:consumer_id/wait-credit` |
| `consumer.delete` | human, agent | `DELETE /api/consumers/:consumer_id` |
| `consumer.stop_loop` | human; through a proxy node, only for a loop of its machine | `POST /api/consumers/:consumer_id/loop-stop` |
| `consumer.prompt` | human; through a proxy node, only for a loop of its machine | `POST /api/consumers/:consumer_id/prompt` |
| `loops.message_all` | human; through a proxy node with `scope: "machine"` only | `POST /api/loops/message-all` — a message typed into every agent loop (or the ones in `consumers`), held too with `hold`. `scope`: `all` (the default) reaches every connected loop, `machine` the loops of the caller's machine — a node answers it itself, for its own loops. The message reaches a loop on any machine; a hold goes through the loop's socket, so with `all` a loop on another machine has `hold: "failed"` and why in `hold_error`. Answers `{ action, scope, results }`, one line per loop |
| `loops.release_all` | human; through a proxy node with `scope: "machine"` only | `POST /api/loops/release-all` — lifts the hold, with the same `scope` and `consumers`; answers `{ action, scope, results }` |
| `project.launch` | human | `POST /api/projects/:name/launch` — one of the project's known roots only |
| `launcher.list` | human, agent | `GET /api/launchers` |
| `launcher.run` | human | `POST /api/launchers/:id/run` — a launcher that cannot start is a 500 |
| `node.list` | human | `GET /api/nodes` |
| `node.pairing` | human | `GET /api/nodes/pairing` |
| `node.set_pairing` | human | `POST /api/nodes/pairing/:verb` — `open` (with `minutes`) or `close` |
| `node.enrollments` | human | `GET /api/nodes/enrollments` |
| `node.decide_enrollment` | human | `POST /api/nodes/enrollments/:id/:verdict` — 409 when no longer pending |
| `node.revoke` | human | `DELETE /api/nodes/:node_id` |
| `signal_key.list` | human | `GET /api/signal-keys` |
| `signal_key.create` | human | `POST /api/signal-keys` — the only answer that carries the token |
| `signal_key.update` | human | `PATCH /api/signal-keys/:key_id` |
| `signal_key.revoke` | human | `DELETE /api/signal-keys/:key_id` |
| `project.signals` | human | `GET /api/projects/:name/signals` |
| `upload.max_bytes` | human, agent | — how large one upload may be, with the default and the hard cap |
| `upload.set_max_bytes` | human, agent | — change it, up to the hard cap |
| `step.trim` | human | — cut every waiting step down to `max_minutes` from now |
| `ping.purge_seen_closed` | human, or a local caller | — delete the read pings that point at closed tickets |
