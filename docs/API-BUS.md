# The bus

> **Status: clients are moving onto it.** The transport, identity, calls,
> batches and revocation are in place, and the operations tvty uses are
> becoming methods (see *Methods*). Subscriptions come next. Until a client
> has moved, it keeps using the HTTP API ([`API.md`](./API.md)); a route that
> has become a method answers exactly as the method does.

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

The caller is authenticated **once**, on this opening request, by the same code
as an HTTP request, and every call on the connection runs as that caller. An
opening that fails is answered in HTTP with `{ error, code }` (401
`AUTH_REQUIRED` or `TOKEN_INVALID`, 403), and no connection is made.

The daemon's first message is a notification:

```json
{ "jsonrpc": "2.0", "method": "bus.hello",
  "params": { "version": 1, "consumer": "claude-aiball-dev", "kind": "agent", "relayed": false } }
```

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

## Methods

Parameters are the fields the HTTP route took — its path, query and body
fields, under the same names — as one object. Results are the route's body.

| Method | Callers | Replaces |
|---|---|---|
| `bus.whoami` | human, agent | — who the connection runs as: `{ consumer, kind, relayed, transport }` |
| `tag.list` | human, agent | `GET /api/tags` |
| `project.milestones` | human, agent | `GET /api/projects/:project/milestones` |
| `mention.suggestions` | human, agent | `GET /api/mention-suggestions` |
| `consumer.list` | human, agent | `GET /api/consumers` |
| `consumer.backlog` | human, or the agent itself | `GET /api/consumers/:consumer_id/backlog` |
| `consumer.bar` | human, or the agent itself | `GET /api/consumers/:consumer_id/bar` |
| `consumer.set_bar_host` | human, not relayed | `POST /api/consumers/:consumer_id/bar-host` |
| `consumer.afk` | human, not relayed | `POST /api/agents/:name/afk` |
| `message.get` | human, agent | `GET /api/messages/:id` |
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
| `ticket.set_owner` | human | `POST /api/tickets/:id/owner` |
| `ticket.release` | human, agent | `POST /api/tickets/:id/release` |
| `ticket.mark_read` | human, agent | `POST /api/tickets/:id/mark-read` |
| `ticket.postpone` | human | `POST /api/tickets/:id/postpone` |
| `ticket.unsnooze` | human | `POST /api/tickets/:id/unsnooze` |
| `ticket.move` | human, or the reporter | `POST /api/tickets/:id/move` |
| `ticket.set_milestone` | human, or a cto agent | `POST /api/tickets/:id/milestone` |
