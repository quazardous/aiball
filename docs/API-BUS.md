# The bus

> **Status: the transport is in place; clients are moving onto it.** Today the
> bus carries the connection, identity, calls, batches and revocation, with one
> method (`bus.whoami`). The core's operations become methods client by client
> (tvty first, then claude-loop, the MCP server and the CLI, then the web UI),
> and subscriptions come with them. Until a client has moved, it keeps using
> the HTTP API ([`API.md`](./API.md)).

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
  "params": { "version": 1, "consumer": "claude-aiball-dev", "kind": "agent" } }
```

`kind` is the kind of caller the connection is (see *Who may call a method*).

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
before running it (403 `FORBIDDEN` otherwise):

| Kind | Who |
|---|---|
| `human` | a human, on the local socket or with their own token |
| `agent` | an agent, on the local socket or with its own token |
| `node` | anyone relayed by a proxy node ([`SECURITY.md`](./SECURITY.md)) — a node relaying a human is still a `node` |
| `key` | an API key; the method also names the scope the key needs (403 `KEY_SCOPE_MISSING` without it) |

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

| Method | Callers | Params | Result |
|---|---|---|---|
| `bus.whoami` | human, agent, node | none | `{ consumer, kind, transport }`: who the connection runs as |
