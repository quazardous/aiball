# Architecture: the core and its clients

aiball is moving toward a **core** — the daemon, its database, its rules and its
API — that every other part uses as a client. The terminal-side tools (claude-loop,
tvty) and the agents' MCP server must be able to run on the core alone; the web UI
is one more client, useful but not essential.

This page says where the line is today, what holds it, and what is still on the
wrong side of it.

## The layers

| Layer | What | Where |
|---|---|---|
| **Core** | the database and its migrations, the rules (actionable, decisions, backlog, wakes), the bus and the HTTP/UDS API, authentication | `src/db*`, `src/schema.ts`, `src/messages.ts`, `src/queries/`, `src/bus/`, `src/sessions/`, `src/api*`, `src/app.ts`, `src/daemon.ts`, `src/ws.ts` |
| **Shared vocabulary** | pure modules any layer may import: kinds, decision gestures, transitions, config parsing | `src/domain.ts`, `src/decisions.ts`, `src/ticket-transitions.ts`, `src/autopoll/config.ts`, … |
| **Clients** | talk to the core through the API only | `src/client.ts` (the shared client), `src/claude-loop/`, `src/mcp/`, `src/cli/`, `src/sim/`, `tests/sim/`, the tvty terminal (its own repository) |
| **Web UI** | a client of the same API | `frontend/` |

### Inside the core

| Where | What goes there |
|---|---|
| `src/db/` | a table's reads and writes |
| `src/queries/` | the reads composed from several tables that several methods, and the core itself, answer with: ticket lists and the work order, inbox rows and their pilot fields, a thread's pagination, the tag catalog, the tags and votes added to message rows |
| `src/bus/` | the bus: its methods (`src/bus/methods/`), and next to them the helpers only they use |
| `src/api/` | the HTTP routes production keeps (logging in, uploads, API keys' doors, a few consumer routes) and their helpers |

## The rule, and what holds it

**A client never imports the core.** It reaches the data through the API — the
shared client `src/client.ts`, or plain HTTP for a client in another language
(tvty). The rule holds transitively: a shared module a client imports must not pull
the database in either.

`src/architecture.test.ts` follows the import graph of every client directory and
fails on the first chain that reaches a core module. Type-only imports do not count
(the compiler erases them; they load nothing).

### Named exceptions

Two CLI commands act on the local database directly, because they are local
administration run where the daemon's data lives:

- `aiball auth` issues and revokes tokens;
- `aiball backup` copies the database file.

They are listed in the test by name; a new crossing has to be added there, in the
open.

## Known couplings, still on the wrong side

- **The daemon serves the web UI's files** (`frontend/dist`) from `src/app.ts`: the
  core cannot yet start without knowing the UI exists.
- **Some response shapes are cut for the web list** (`/api/inbox`, whose row is
  documented in [`API-INBOX.md`](./API-INBOX.md)), and the web UI still computes its
  own turn and bands instead of reading the server's (`view=turn`).
- **Uploads are also served outside `/api`** (`/uploads/<sha>.<ext>`), without the
  API's authentication: a file is readable by whoever knows its 64-hex-digit hash (a
  capability URL, which is what lets a browser `<img>` load it — see
  [`SECURITY.md`](./SECURITY.md)). The authenticated route is `/api/uploads/<sha>`.
- **The MCP server borrows two helpers from claude-loop** (token capture, the install
  root): a coupling between two clients, not with the core.
- **`src/client.ts` imports a type from `src/event-bus.ts`**, which types itself on
  the database's `Message`: no code crosses at run time, but the client's types
  still depend on the core's.
- **The API's contract is written in parts** ([`API.md`](./API.md) is the index): the
  inbox row, filing a ticket, refusals. Routes and fields outside those parts still
  exist only in the code. tvty calls the API by hand, outside the shared client; its
  calls are tested on aiball's side instead (`src/api/tvty-contract.test.ts`).

## Uploads in texts

A text cites an upload as `/uploads/<sha>.<ext>` — `<sha>` the file's SHA-256 in
lowercase hex (64 digits), `<ext>` 1 to 8 letters or digits. That is the stable
reference form: a client may rewrite it (for instance to `/api/uploads/<sha>`, or
to a local file) by matching `/uploads/([a-f0-9]{64})\.([A-Za-z0-9]{1,8})`.
Wherever a text is returned — a thread (and each of its comments), a single
message — its uploads come resolved in `attachments`: `sha`, `ext`,
`content_type`, `bytes`, `ref` (the web path), `api_ref` (the API path), and
`uri`, a `file://` path when the caller is on the same host.

## The routes and who calls them

[`API-ROUTES.md`](./API-ROUTES.md) lists every route and the consumers that call it,
generated from the code by `npx tsx scripts/route-inventory.ts`. Regenerate it when
routes or clients change. It is what shows which routes the core must keep for its
terminal clients, which serve the web UI alone, and which no code calls at all.

## Open questions

- Where exactly the core ends: whether serving the web UI's files, and the routes
  only the web UI uses, stay in it or move to a UI layer.
- A written API contract (a document or a schema), and whether tvty should use a
  shared client rather than its own calls.
- Packaging: the core and the web UI as separate packages, and a daemon that starts
  without a UI.
