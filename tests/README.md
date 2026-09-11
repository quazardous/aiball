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

### ✅ decision-on-comment (#B.129) — `scenario-decision.ts`
- **Setup**: `agent-b` proposes a plan (`comment_added` + `decision_kind=plan` → a
  pending decision); `agent-a` (reporter) accepts it via `POST /api/messages/:id/decide`.
- **Assert**: `meta.decision` goes `pending` → `accepted` (kind stays `plan`).

### ✅ move cross-project (#294) — `scenario-move.ts`
- **Setup**: `agent-a` opens a ticket in `move-src`; the reporter moves it to `move-dst`
  via `POST /api/tickets/:id/move`.
- **Assert**: the head's `project` flips `move-src` → `move-dst`.

### ✅ delete comment (#309) — `scenario-delete-comment.ts`
- **Setup**: human `human-mod` opens a ticket; `agent-a` comments (gets deleted),
  `agent-b` comments (stays). Addresses comments by id → `seedCounters()`.
- **Assert** (`POST /api/messages/:id/delete`):
  - **guards** — an agent's delete → `403` (human-moderator only); deleting the
    ticket head → `400` (only comments can be deleted).
  - **soft-delete** — the response is `status=rejected` + `meta.deleted={by,at}`.
  - **excluded** — cA gone from the normal thread (cB intact, delete is targeted),
    `comment_count` drops 2→1, and cA's ping is wiped from the subscriber's `unread`.
  - **tombstone** — `?include_deleted=1` re-surfaces cA with `body=null` +
    `meta.deleted` (the UI placeholder), never the original text.

### ✅ moderation rules — `scenario-moderation.ts`
- **Setup**: two project-scoped rules — `R_auto` (pos 0, match `by_agent=agent-auto`
  → `auto`) and `R_review` (pos 10, match `kind=comment_added` → `review`). A human
  `human-mod` (`provisionHuman`) opens the parent ticket.
- **Assert** (engine: `src/rules.ts evaluate()`), reading `status` + `matched_rule_id`
  off the `POST /api/messages` response:
  - **human bypass** — human-mod's `ticket_created` is `approved` despite the default.
  - **review** — `agent-a`'s comment matches `R_review` (kind) → `pending` (the rule
    overrides the permissive `auto-reply` default).
  - **auto + first-match-wins** — `agent-auto`'s comment matches BOTH rules but
    `R_auto` (lower position) wins → `approved` with `matched_rule_id=R_auto.id`.
  - **human bypass over a rule** — human-mod's comment WOULD match `R_review` but
    `isHuman()` short-circuits → `approved` with `matched_rule_id=null` (the null is
    what distinguishes a bypass from a rule-driven auto).
- **Note**: assertions are env-default-independent (every rule is `match_project`-scoped;
  outcomes are forced by the rules + the human bypass, not the ambient strategy).

### ✅ tags consumers / state_human_word (#310) — `scenario-tags-consumers.ts`
- **Setup**: a loop agent `tagscons-agent` (kind=agent) and a human `tagscons-human`.
  Consumer state is **global** (not project-scoped) → scenario-unique consumer ids.
- **Assert** (`PUT /api/consumers/:id/state` → `GET /api/consumers`):
  - each presence word `stop`/`wait`/`loop` pushed (`human_word`) is reflected on the
    consumers page (`state_human_word`); an unknown word is ignored (last value stays).
  - **guards** — a human pushing state → `403` (badges are for loop agents); an agent
    pushing another consumer's state → `403` (own-state only).

## Out of scope here

- **intent=feature branch hint (#319)** — the hint is composed by `buildWakePhrase()`
  in `src/claude-loop/state.ts` and pasted into the tmux session at wake; it's **never
  serialized over HTTP**, so it can't be asserted by this daemon stack. Belongs to the
  claude-loop / tier-2 layer (or a pure-logic unit on `buildWakePhrase`).
- **claude-loop / tier-2** (typing→wait #315, the stop/wait/loop bar #302/#305) —
  covered separately (david).
- **attribution (#322)** + **per-agent workflow (#323)** — await the multi-agent /
  sandbox layer.

## Board simulator — `npm run sim`

The rules that decide what an agent sees (last actor, pending decisions, claims,
handback and steps, dependencies, backlog tiers) are tested one by one; the
simulator shows them **together**, on a board you can watch and moderate.

- **The board:** the real daemon and web UI, in this stack's `daemon` container
  under its own compose project (`aiball-sim`) and port (`AIBALL_SIM_PORT`,
  default **17780**), on a throwaway database. It never meets the live board nor
  `npm run test:e2e`.
- **The cohort** (`tests/sim/cohort.yaml`): a human moderator who logs into the
  web UI, projects with their lead agent, and extra agents following a project.
- **Simulated agents** call the **real MCP tool handlers** with their own token,
  so a gesture is refused or accepted exactly as it would be for a real agent.

| Command | What |
|---|---|
| `npm run sim -- up [cohort.yaml]` | build and start the board, provision the cohort, print the logins |
| `npm run sim -- up --from-live --as <agent>[,<agent>] [--moderator <human>]` | start the board on a sanitized copy of the live board, playing those real agents (see below) |
| `npm run sim -- mcp <agent> <tool> '<json>'` | call an MCP tool as that agent |
| `npm run sim -- wake <agent>` | what the loop does when that agent goes idle, now (as the scenario step) |
| `npm run sim -- view [agent...]` | each agent's seat: every open ticket's backlog tier, whether it can act or claim, what gates it, the last actor, and what its **next wake** would say |
| `npm run sim -- run [--keep] [scenario.yaml...]` | play scenarios (default: every `tests/sim/scenarios/*.yaml`), each on a fresh board unless `--keep`; exits 1 if a gesture fails or an expectation does not hold |
| `npm run sim -- pending` / `approve <id>` / `reject <id>` | moderate from the terminal (or use the web UI) |
| `npm run sim -- down` | stop the board and drop its database |

The board listens on `127.0.0.1` only: its moderator password is known.

### On a copy of the live board

`up --from-live --as <agents>` answers "what would this agent's loop do on the
real board, and what if…" without touching the real board:

1. the live database (`$AIBALL_LIVE_HOME`, default `~/.local/share/aiball`) is
   copied with SQLite's own backup, which is consistent while the daemon writes;
2. the copy is wiped **on this host, before it reaches the container**: every
   token (agents, sessions, nodes, signal keys, install), every password, the
   node wiring and pairing requests, and every ticket payload
   (`src/sim/sanitize.ts`; its test fails on any new column that looks secret
   until it is wiped or classified there);
3. the board starts on that copy, with a token for each agent named by `--as`
   (seated in the project it owns) and the moderator's password set to
   `simulator` (`--moderator`, default `david`).

`view <agent>` then shows the seat that agent's loop has live, and every gesture
(`mcp`, `wake`, moderation, a scenario with `run --keep`) plays on the copy
only. `down` drops it.

The next wake is worked out like the loop does it: unread pings first, then the
head of the agent's backlog (the first ticket not in cooldown), ended with the
loop's own wording for that tier. `src/sim/view.test.ts` fails if that wording
drifts from `src/claude-loop/state.ts`.

### Scenarios

A scenario (`tests/sim/scenarios/*.yaml`) is a list of steps:

```yaml
name: a sole participant keeps its ticket after a handback
steps:
  - alpha-lead: ticket_new                 # an agent calls an MCP tool
    args: { title: "…" }
    save: { ticket: id }                   # $ticket = the result's `id`
  - moderator: approve $ticket              # approve | reject | accept | refuse | comment
  - alpha-helper: ticket_reply
    args: { target_id: $ticket, body: "…", summary_until: "…", handback: false }
    refused: claim it first                 # the call must fail with this in its error
  - expect:
      alpha-lead: { ticket: $ticket, backlog: actionable, act: true, wake: triage }
  - view: [alpha-lead]
  - wake: alpha-lead                        # the loop wakes the agent now
  - pause: look at the web UI               # waits for Enter in a terminal
```

`expect` checks any of `backlog` (hot, actionable, follow-up, waiting, blocked,
none), `act`, `claim`, `gated`, `last_actor` and `wake` (triage, followup,
waiting, blocked, event for unread pings first, none) for one ticket. A gesture
that fails stops the scenario; an expectation that does not hold is reported and
the scenario goes on.

Cases waiting for a scenario, and what the simulator still needs to play them,
are listed in `tests/sim/CASES.md`.

`wake` does what the loop does when the agent goes idle: with unread pings it is
an event wake (the events on the oldest one's ticket are marked seen, as the loop
delivers them in one bundle); otherwise it names the backlog head and records
that wake, which sinks the ticket for the cooldown until the thread moves again
(only 5 minutes when the ticket's last action is a step).

More steps and fields:

- `cohort: tests/sim/cohorts/<file>.yaml` at the top of a scenario: `run` starts
  its board with that cohort (two owners of one project, a `can_claim: false`
  specialist…).
- `cooldown: 60s` at the top of a scenario: the backlog cooldown its views,
  expectations and wakes are played with (default an hour, the loop's own), so
  a scenario can watch a sunk ticket come back without waiting an hour. It only
  changes what the simulator asks the daemon, not the daemon.
- Moderator gestures also include `close`, `reopen`, `snooze $ticket 2m`,
  `assign $ticket <agent>` and `step $comment` (tag an agent's comment as a
  step). `may_fail: true` on a moderator step reports a
  refusal and goes on: for a case whose rule is still to pin down, the refusal
  is the answer.
- `sleep: <seconds>` (or `30s`, `2m`) waits, for snoozes and cooldowns.
- `expect` also takes `rank` (the ticket's position in the agent's `ticket_list`
  work order, 0 when not listed) and `events` (the kinds of the agent's unread
  events on that ticket, oldest first).
