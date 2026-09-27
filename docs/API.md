# The API contract

aiball's core is the bus ([`API-BUS.md`](./API-BUS.md)): methods and
subscriptions over one connection per client, on TCP and on the local Unix
socket. HTTP keeps the web UI's files, uploads, login and a few routes for
peripheral clients, and the routes that still serve a method until they go. The web UI, claude-loop, the MCP server, the `aiball` CLI and tvty
are its clients. This page says where the contract is written, and what a client
may rely on.

## Where it is written

| Page | What it fixes |
|---|---|
| [`API-BUS.md`](./API-BUS.md) | The bus: one connection per client, JSON-RPC 2.0, who may call a method, errors, batches, revocation. Where every client is moving. |
| [`API-INBOX.md`](./API-INBOX.md) | The inbox row, **versioned**: every field, the query, `holder` / `held_as`, the `view=turn` fields and their values. |
| [`API-FILING.md`](./API-FILING.md) | Filing a ticket in one call, with its tags, assignee, milestone, level and parent; who may set what. |
| [`API-ERRORS.md`](./API-ERRORS.md) | Refusals: `{ error, code }`, the generic code per status, the precise codes and the routes that answer them. |
| [`SECURITY.md`](./SECURITY.md) | Who the caller is (token over TCP, the `x-aiball-consumer` header on the socket), and that the author of a write is the caller. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | The layers, and how uploads are cited in texts (`/uploads/<sha>.<ext>`) and served under the API (`/api/uploads/<sha>`). |
| [`CLAUDE-LOOP.md`](./CLAUDE-LOOP.md) | A loop's bar as data (`GET /api/consumers/<agent>/bar`, the `agent_bar` event) and who draws it. |
| [`API-ROUTES.md`](./API-ROUTES.md) | Every route and the clients whose code calls it, generated from the code. |

## What a client may rely on

- **A refusal's `code`**, not its sentence.
- **The fields of the documented shapes** above. The inbox row carries a schema
  version; a field removed or changed in meaning bumps it.
- **The author** of what it writes is who it is authenticated as; it never sends
  its name in a body.

What is **not** written yet is not a promise: a route or a field that appears
only in the code may change. Ask for it to be documented before depending on it.

## A client in another language

A client that cannot share `src/client.ts` (tvty is written in Rust) gets its
contract **tested on aiball's side**: `src/api/tvty-contract.test.ts` replays
tvty's calls as it sends them — over the socket, with its exact bodies — and
checks that every field it reads is there, with its type. Most of those fields
are optional on tvty's side, so a field dropped by aiball would not break tvty,
it would silently lose a feature; here it fails the test. The test also checks
that every route tvty calls is covered: when tvty's checkout sits next to this
one (or at `AIBALL_TVTY_DIR`), it reads tvty's sources live, with the route
inventory's own reader, so a call tvty adds fails the test at once, naming
tvty's commit; without the checkout (Docker, CI), it reads `API-ROUTES.md`.
When tvty changes what it reads, the field table in the test changes with it.

The bus's contract is published, generated from the code: the methods as an
OpenRPC document ([`api-bus.openrpc.json`](./api-bus.openrpc.json), also served
by `rpc.discover`) and the subjects as an AsyncAPI document
([`api-bus.asyncapi.json`](./api-bus.asyncapi.json), served by `bus.subjects`).
A test fails when the written documents are not what the code produces, and
checks that every method and subject tvty's code names is in them.
