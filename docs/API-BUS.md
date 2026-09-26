# The bus

> **Status: clients are moving onto it.** Calls, batches, subscriptions and
> revocation are in place, and the operations tvty uses are methods (see
> *Methods*). aiball's own clients (the MCP server, the CLI, claude-loop)
> call every operation that is a method over the bus, and the rest over HTTP
> until it becomes one. Until a client has moved, it keeps using the HTTP API
> ([`API.md`](./API.md)); a route that has become a method answers exactly as
> the method does.

The bus is how a client talks to aiball: **one permanent connection** per
client, JSON-RPC 2.0 over a WebSocket. The core is a table of **methods**,
functions of the caller and their parameters; the bus calls them directly.
HTTP stays for what a browser fetches by URL: the web UI's files, and uploaded
files.

## Connecting

The WebSocket is at **`/bus`**:

- on the local socket (`~/.local/share/aiball/sock`): the same trust as `/api`
  there, the same user, no token. Who you are is the `x-aiball-consumer`
  header, `human` without it;
- over TCP: a token, as for `/api` — `Authorization: Bearer <token>`, or
  `?token=` where headers cannot be set (a browser).

**Through a proxy node** ([`REMOTE.md`](./REMOTE.md)), `/bus` is on the node's
socket and port too: the node relays each connection to its upstream's `/bus`,
one upstream connection each, opened as it relays `/api` (the caller's own
token when it has one; otherwise the node token and the consumer named — never
in strict mode). Messages pass as they are; the `bus.hello` is the upstream's;
either side closing closes the other. The upstream sees the caller relayed
(see *Who may call a method*).

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
{ "jsonrpc": "2.0", "id": 1, "result": { "consumer": "claude-aiball-dev", "kind": "agent", "transport": "uds" } }
```

- A message without `id` is a notification: it runs, and gets no answer.
- Frames on one connection are answered **in the order they came**: a read sent
  after a write sees it.
- A frame is at most 4 MiB; a larger one closes the connection (1009).

**Batches.** An array of calls (at most 100) runs in order and is answered in
one frame, an array of the answers (notifications left out). Each call settles
on its own: one refused does not stop the others.

## Errors

A method's refusal is the refusal the matching HTTP route gives: its JSON-RPC
`code` is the HTTP status, and `data.code` is aiball's error code
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
| `agent.<id>.state` | the entry `consumer.list` gives | the whole entry again, built by the same code, whenever it changed (presence, loop state, pings, credit, `session`); `null` once the consumer is deleted | humans and agents |
| `project.<p>.tickets` | the rows `inbox.list` gives with `view: "turn"`; options `open`, `include_postponed` | `{ op: "upsert", row }` or `{ op: "remove", id, project }` | humans and agents; the rows are the subscriber's |
| `ticket.<id>` | what `ticket.get` gives with `full: true` | `{ type, message }`: `message_created`, `_edited`, `_decided`, `_noted`, `_tagged` | humans and agents |
| `user.<id>.pings` | `{ unread }` | a ping, as the event stream carries it, and `message`: what it points at (`id`, `hashid`, `kind`, `status`, `by_agent`, `created_at`, `project`, `ticket_id`, `title`, `decision`) | oneself |
| `session.<name>.state` | a session without an agent, as `session.list` gives it, or `null` | `{ name, session }`: started, clients, exited, and `session: null` once stopped | humans and agents |

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
(the loop controls) refuses a relayed caller, whoever it names.

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

Parameters are the fields the HTTP route took — its path, query and body
fields, under the same names — as one object; a query's yes/no flag is a
boolean, and its "1" is accepted too. Results are the route's body.

| Method | Callers | Replaces |
|---|---|---|
| `bus.whoami` | human, agent | — who the connection runs as: `{ consumer, kind, relayed, transport }` |
| `rpc.discover` | human, agent | — this bus's methods, as OpenRPC |
| `bus.subjects` | human, agent | — this bus's subjects, as AsyncAPI |
| `bus.subscribe` | human, agent | — see *Subscriptions* |
| `bus.unsubscribe` | human, agent | — see *Subscriptions* |
| `session.start` | human, not relayed | — a session on this machine ([`SESSION-HOST.md`](./SESSION-HOST.md)); `HOST_BUSY` |
| `session.stop` | human, not relayed | — ends a session and its host |
| `session.list` | human, agent | — every session this daemon hosts |
| `inbox.list` | human, agent | `GET /api/inbox` — the result is `{ total, rows }`: the rows (with `view: "turn"`, the pilot's fields; see [`API-INBOX.md`](./API-INBOX.md)) and the count HTTP sends as `X-Total-Count` |
| `ticket.get` | human, agent | `GET /api/tickets/:id` — flags (`full`, `brief`, `digest`, `include_deleted`) are booleans |
| `tag.list` | human, agent | `GET /api/tags` |
| `project.milestones` | human, agent | `GET /api/projects/:project/milestones` |
| `mention.suggestions` | human, agent | `GET /api/mention-suggestions` |
| `consumer.list` | human, agent | `GET /api/consumers` |
| `consumer.backlog` | human, or the agent itself | `GET /api/consumers/:consumer_id/backlog` |
| `consumer.bar` | human, or the agent itself | `GET /api/consumers/:consumer_id/bar` |
| `consumer.set_bar_host` | human, not relayed | `POST /api/consumers/:consumer_id/bar-host` |
| `consumer.afk` | human, not relayed | `POST /api/agents/:name/afk` |
| `consumer.restart_claude` | human, not relayed | — restarts an agent's Claude after it installed an update (its bar's `alerts.restart_needed`): refused `NOT_IDLE` while Claude works; the loop resumes the conversation and tells the agent once it is back |
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
| `unread.list` | human, agent | `GET /api/unread` — `consumer_id` left out is the caller |
| `unread.count` | human, agent | `GET /api/unread/count` |
| `unread.mark_read` | human, agent; another consumer's backlog or `delete`, human | `POST /api/mark-read` |
| `message.pending_count` | human, agent | `GET /api/my-pending/count` — `by_agent` left out is the caller |
| `consumer.micro_status` | human, agent | `GET /api/micro-status` |
| `ping.list` | human, agent | `GET /api/pings` |
| `ping.count` | human, agent | `GET /api/pings/count` |
| `ping.mark_read` | human, agent | `POST /api/pings/mark-read` |
| `backlog.record_wake` | human, agent | `POST /api/backlog-wake` |
