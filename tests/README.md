# aiball test stack (#324) — scenarios (#328)

Two complementary layers, one stack (#dz8sm5):

| Layer | Command | What | Where |
|---|---|---|---|
| **Pure logic** | `npm test` | fast `node:test` units, no DB | `src/**/*.test.ts` |
| **e2e scenarios** | `npm run test:e2e` | real daemon in Docker, business-API cinématiques | `tests/scenario-*.ts` |

## e2e — how it works

`npm run test:e2e` (= `bash tests/run-e2e.sh`):
1. `docker compose -f tests/docker-compose.yml up --build` — the **real daemon**
   (`createApp`) in a container: `NODE_ENV=test`, isolated **ephemeral DB volume**,
   host port **17777** (≠ the live `7777`), healthcheck on `/api/health`.
2. runs **every** `tests/scenario-*.ts` **inside** the daemon container
   (`docker compose exec`) — so a scenario shares the DB (to mint tokens) and
   reaches the daemon on `localhost`.
3. `docker compose down -v` (drops the DB volume + network).

Exit code = 0 only if all scenarios pass.

### Conventions (the discipline, #cta34j)

- **Drive the business API only** (`POST /api/messages`, `GET /api/unread`, …).
  If a scenario needs CRUD gymnastics to progress, that's the signal a **business
  operation is missing** — the stack *audits* that the API is business, not CRUD.
- The **only** non-API touch allowed is **agent provisioning** (`provision()` in
  `tests/lib.ts`: `ensureConsumer` + `issueToken`), since auth is bearer-token.
- Each scenario uses a **distinct `project`** → no interference on the shared
  daemon. (No per-scenario daemon restart needed.)
- Native module note: `better-sqlite3` is compiled **in-image** (`tests/Dockerfile`
  `npm ci`); the host `node_modules` can't be reused (ABI).

### Add a scenario

Create `tests/scenario-<name>.ts` importing the helpers from `tests/lib.ts`
(`provision` / `post` / `unread` / `ok` / `fail`). `run-e2e.sh` auto-discovers it.

## Scenarios

### ✅ fan-out — `scenario-fanout.ts`
- **Setup**: `agent-a` opens a ticket (→ auto-subscribes A).
- **Act**: `agent-b` comments (with `summary_until`).
- **Assert**: A's `unread` contains B's comment (fan-out reaches the subscriber).
- **Audited**: agent `comment_added` requires `summary_until` (humans exempt).

### ✅ self-ping (#296) — `scenario-selfping.ts`
- **Setup**: `agent-a` opens a ticket; `agent-b` comments; `agent-a` comments on its own ticket.
- **Assert**: A's `unread` contains B's comment but **NOT** A's own → no self-ping.

### ✅ decision gate (#273) — `scenario-decision-gate.ts`
- **Setup**: human `david` (`provisionHuman`, bypasses moderation so the ticket is
  approved) files a ticket the agent `agent-a` works; `agent-a` proposes a plan
  (`comment_added` + `decision_kind=plan` → pending).
- **Assert**: the ticket starts **in** `agent-a`'s actionable pool, **leaves** it while
  the decision is pending, a later **human** comment makes it **re-enter** (recency
  #358 — the ball comes back to the agent), and a fresh `plan:pending` re-gates it
  (**last-signal-per-ticket-wins**). Drives `GET /api/tickets?actionable=1`.
- **Note**: pure logic also covered in unit (`src/db/decision-gate.test.ts`, 14 cases).

### ✅ bus lifecycle (#321) — `scenario-bus-lifecycle.ts`
- **Setup**: the lifecycle bus (`src/event-bus.ts`) is an **in-process** EventEmitter,
  so it can't be observed over HTTP from the shared daemon (another process). This
  scenario instead mounts the **real app in-process** (`createApp`, the affordance
  `src/app.ts` was extracted for) on an ephemeral port and subscribes `onLifecycle`
  in the **same** process, then drives the business API against that local instance.
- **Act**: create a ticket → propose+accept a plan → move the ticket cross-project.
- **Assert**: an `onLifecycle` handler receives exactly **one** `created`, one
  `decided`, one `moved` — **one event per mutation, no double-fire** (the move must
  not also fire a stray `created` for its audit comment). The dedup regression net.

### ☐ decision-on-comment (#B.129)
- **Setup**: propose a plan/resolution (pending); reporter/human `POST /decide`.
- **Assert**: `meta.decision` goes `pending`→`accepted`/`rejected`; accepting a
  resolution closes/ungates as expected; re-deciding a terminal decision is rejected.

### ☐ move cross-project (#294)
- **Setup**: `agent-a` opens a ticket in project X; reporter/human moves it to Y.
- **Assert**: the head's `project` becomes Y with a fresh `display_seq`; an audit
  comment lands; fan-out reaches the **destination** project; comments follow.

### ☐ delete comment (#309)
- **Setup**: a comment exists; a **human** deletes it.
- **Assert**: `status=rejected` + `meta.deleted`; excluded from counts/gates/thread
  (tombstone in `include_deleted=1` view only).

### ☐ moderation rules
- **Setup**: a rule matching `project`/`kind`/`by_agent` → `auto` or `review`.
- **Assert**: a new message's status follows the rule (auto-approved vs pending);
  a registered **human** author bypasses moderation.

## Out of scope here

- **claude-loop / tier-2** (typing→wait #315, the stop/wait/loop bar #302/#305) —
  covered separately (david).
- **attribution (#322)** + **per-agent workflow (#323)** — await the multi-agent /
  sandbox layer.
