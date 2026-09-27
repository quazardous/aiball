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
| `agent.<id>.state` | the entry `consumer.list` gives | the whole entry again, built by the same code, whenever it changed (presence, loop state, pings, credit, `session`); `null` once the consumer is deleted | humans and agents |
| `project.<p>.tickets` | the rows `inbox.list` gives with `view: "turn"`; options `open`, `include_postponed` | `{ op: "upsert", row }` or `{ op: "remove", id, project }` | humans and agents; the rows are the subscriber's |
| `ticket.<id>` | what `ticket.get` gives with `full: true` | `{ type, message }`: `message_created`, `_edited`, `_decided`, `_noted`, `_tagged` | humans and agents |
| `user.<id>.pings` | `{ unread }` | a ping, as the event stream carries it, and `message`: what it points at (`id`, `hashid`, `kind`, `status`, `by_agent`, `created_at`, `project`, `ticket_id`, `title`, `decision`) | oneself |
| `session.<name>.state` | a session without an agent, as `session.list` gives it, or `null` | `{ name, session }`: started, clients, exited, and `session: null` once stopped | humans and agents |
| `agent.<id>.events` | `{ consumer_id, unread }` | `{ event, data }`: a `ping` (not one outside the wake focus), a loop `control` (`kill`, `prompt`, `restart_claude`), a `signal`; the waiting signals and spooled prompts come right after the answer; the subscription is the loop's liveness; never replayed | the loop itself |
| `board.events` | `null` | every event the board broadcasts, `{ type, data }`, the feed the web UI patches its views from | humans and agents |
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

Parameters are the fields the HTTP route took, when there was one — its path,
query and body fields, under the same names — as one object; a yes/no flag is
a boolean, and "1" is accepted too. Results are what the route answered.

| Method | Callers | Replaces |
|---|---|---|
| `bus.whoami` | human, agent | — who the connection runs as: `{ consumer, kind, relayed, transport }` |
| `rpc.discover` | human, agent | — this bus's methods, as OpenRPC |
| `bus.subjects` | human, agent | — this bus's subjects, as AsyncAPI |
| `bus.subscribe` | human, agent | — see *Subscriptions* |
| `bus.unsubscribe` | human, agent | — see *Subscriptions* |
| `session.start` | human, not relayed | — a session on this machine ([`SESSION-HOST.md`](./SESSION-HOST.md)); `HOST_BUSY` |
| `session.stop` | human; an agent its own session, locally (its loop's `rm`); not relayed | — ends a session and its host |
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
| `unread.list` | human, agent | `GET /api/unread` — `consumer_id` left out is the caller |
| `unread.count` | human, agent | `GET /api/unread/count` |
| `unread.mark_read` | human, agent; another consumer's backlog or `delete`, human | `POST /api/mark-read` |
| `message.pending_count` | human, agent | `GET /api/my-pending/count` — `by_agent` left out is the caller |
| `consumer.micro_status` | human, agent | `GET /api/micro-status` |
| `ping.list` | human, agent | `GET /api/pings` |
| `ping.count` | human, agent | `GET /api/pings/count` |
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
| `project.list` | human, agent | `GET /api/projects` — `detailed`, `landscape` are booleans |
| `project.create` | human, agent | `POST /api/projects` |
| `project.stats` | human, agent | `GET /api/projects/:name/stats` |
| `project.standing_prompt` | human, agent | `GET /api/projects/:project/standing-prompt` |
| `project.critical` | human, agent | `GET /api/projects/:project/critical` |
| `project.rename` | human, agent | `POST /api/projects/:name/rename` |
| `project.delete` | human, agent | `DELETE /api/projects/:name` |
| `project.add_token_usage` | human, agent | `POST /api/projects/:project/token-usage` |
| `consumer.presence` | human, agent | `GET /api/presence` |
| `consumer.get` | human, agent | `GET /api/consumers/:consumer_id` |
| `consumer.push_state` | agent, its own | `PUT /api/consumers/:consumer_id/state` |
| `consumer.push_bar` | agent, its own | `PUT /api/consumers/:consumer_id/bar` — on the bus the bar is `bar`; over HTTP it is the whole body |
| `ticket.add_token_usage` | human, agent | `POST /api/tickets/:id/token-usage` |
| `message.list` | human, agent | `GET /api/messages` — `summary`, `open` are booleans |
| `ticket.bookends` | human, agent | `GET /api/tickets/bookends` |
| `session.host` | human or agent, local only | — `claude-loop start --host` runs its prepared command in the agent's session on this daemon's host; the answer carries `control`, the socket the kernel drives |
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
| `daemon.reload` | human or agent, local only | `POST /api/daemon/reload` |
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
| `consumer.stop_loop` | human, never through a proxy node | `POST /api/consumers/:consumer_id/loop-stop` |
| `consumer.prompt` | human, never through a proxy node | `POST /api/consumers/:consumer_id/prompt` |
| `loops.message_all` | human, never through a proxy node | `POST /api/loops/message-all` |
| `loops.release_all` | human, never through a proxy node | `POST /api/loops/release-all` |
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
