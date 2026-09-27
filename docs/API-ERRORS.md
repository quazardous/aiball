# API errors

Every refusal the API answers is JSON:

```json
{ "error": "milestone #12 is already released (closed)", "code": "MILESTONE_RELEASED" }
```

- `error` is a sentence for a human. Its wording may change; don't match on it.
- `code` is the contract. A client branches on it. A code, once shipped, keeps
  its meaning.
- Some refusals carry more fields; they are listed with the code below. A bus
  method ([`API-BUS.md`](./API-BUS.md)) puts them under `details`
  (`details.access`, `details.existing_ticket_id`); an HTTP route puts them
  next to these two (`hint`, `max_bytes`).

The codes live in `ERROR_CODES` (`src/domain.ts`). A refusal that no client has
needed to tell apart yet carries the **generic code of its HTTP status**; a
precise code replaces it when a client needs one. So a client can always
branch on the status's generic code, and a precise code only ever narrows it.

## Generic codes

| Status | Code |
|---|---|
| 400 | `BAD_REQUEST` |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT` |
| 410 | `GONE` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 429 | `TOO_MANY_REQUESTS` |
| 500 | `INTERNAL` |
| 501 | `NOT_IMPLEMENTED` |
| 502 | `BAD_GATEWAY` |
| 503 | `UNAVAILABLE` |

## Precise codes

**Authentication** — on any route:

| Code | Status | When |
|---|---|---|
| `AUTH_REQUIRED` | 401 | No token was sent (over TCP; on the socket too for `POST /api/signals`). Carries a `hint`. |
| `TOKEN_INVALID` | 401 | The token or key is unknown, revoked or expired. |
| `KEY_SCOPE_MISSING` | 403 | An API key without the scope of the door it knocks on (`signals`, `tickets:create`). |
| `AUTHOR_MISMATCH` | 403 | A body names an author (`by_agent`, `set_by`, `answered_by`, `decided_by`) other than the caller. The author of a write is who is authenticated: leave the field out. |
| `TAG_UNKNOWN` | 400 | A tag named, or given by id, that does not exist (filing a ticket, see [`API-FILING.md`](./API-FILING.md)). |
| `MODERATOR_ONLY` | 403 | A gesture reserved to a registered human moderator: snoozing, changing a ticket's owner or level, assigning someone else, managing subscribers, marking a step, deleting or resurfacing a comment, controlling a loop (stop, prompt, AFK, message or release all loops), nodes and pairing, signal keys, protected config keys, launching a loop. |

**Things that do not exist:**

| Code | Status | When |
|---|---|---|
| `TICKET_NOT_FOUND` | 404 | The ticket named in the path, or the `ticket_id` of a new comment. |
| `MESSAGE_NOT_FOUND` | 404 | The message named in `/api/messages/:id/…`. |
| `CONSUMER_NOT_FOUND` | 404 | The agent or human named. |
| `PROJECT_NOT_FOUND` | 400 | The `project` of a new ticket or comment. |
| `LOOP_NOT_FOUND` | 404 | No running claude-loop answers for this agent (`consumer.afk`, `consumer.set_bar_host`, `consumer.restart_claude`). |

**Claiming a ticket** (`POST /api/tickets/:id/assign`):

| Code | Status | When |
|---|---|---|
| `PARENT_PENDING_MODERATION` | 409 | The ticket is not approved yet. Also on `POST /api/messages`: a proposal on a ticket still pending. |
| `TICKET_ASSIGNED` | 409 | The ticket is assigned to someone else. |
| `TICKET_HELD` | 409 | Another agent holds it, still protected. |
| `LEVEL_READ_ONLY` | 403 | The ticket is above the levels this agent works on. Also on `POST /api/messages` and `POST /api/tickets/:id/milestone`. |

**Posting a comment** (`POST /api/messages`):

| Code | Status | When |
|---|---|---|
| `HANDBACK_REQUIRED` | 400 | An agent's comment with no `then` and no `handback`. |
| `HANDBACK_CONTRADICTS` | 400 | A `handback` that says the opposite of the `then`. |
| `COMMITS_REQUIRED` | 400 | An agent's comment that does not say which commits it delivers. |
| `STEP_RESUME_REQUIRED` | 400 | `then: continue` without `resume_on`. |
| `STEP_TIMER_TOO_LONG` | 400 | `resume_on.timer` above the project's maximum (`tickets.steps.max_wait`). |
| `CONFIG_OUT_OF_RANGE` | 400 | `config.set`: a number outside the setting's range. `details` carries `min`, `max`, `step` and `unit`, as `config.managed` gives them. |
| `STEP_RESUME_INVALID` | 400 | `resume_on.ticket` is not a ticket, or is this very one. |
| `STEP_NOT_HOLDER` | 409 | `then: continue` from an agent that does not hold the ticket. |
| `FORBIDDEN_CLOSE` | 403 | Closing a ticket the caller may not close. Also on `POST /api/messages/:id/accept-and-close`. |

**Decisions** (`POST /api/messages/:id/decide`, `…/approve`, `…/reject`):

| Code | Status | When |
|---|---|---|
| `DECISION_SUPERSEDED` | 409 | A newer decision on the ticket replaced this one; decide that one. |
| `ALREADY_MODERATED` | 400 | The message was already approved or rejected (`…/approve`, `…/reject`, `…/accept-and-close`). |
| `MILESTONE_HAS_OPEN` | 409 | Releasing (closing) a milestone that still holds open tickets. Also on `POST /api/messages`. |

**Milestones and relations:**

| Code | Status | When |
|---|---|---|
| `MILESTONE_RELEASED` | 400 | `POST /api/tickets/:id/milestone` with a milestone already released. |
| `MILESTONE_INVALID` | 400 | The same route with something that is not a milestone of the ticket's project (or a milestone put in another). |
| `RELATION_CYCLE` | 409 | `POST /api/tickets/:id/relations`: a lineage that would close a cycle. |
| `ALREADY_IMPORTED` | 409 | `POST /api/tickets/import` and `POST /api/tickets/:id/export`: a ticket already mirrors this upstream issue; `details.existing_ticket_id` names it. |

**Sessions** (the bus's `session.*`, [`SESSION-HOST.md`](./SESSION-HOST.md)):

| Code | Status | When |
|---|---|---|
| `HOST_BUSY` | 409 | `session.start`: the agent's session already runs elsewhere (claude-loop, or a host), or a session of that name already runs; `details.host` says where. |
| `NOT_IDLE` | 409 | `session.handover`: Claude did not become idle within the delay; nothing was stopped. |

## Writing a refusal

In a route, `refuse(res, status, sentence, ERROR_CODES.X)` (`src/api/_helpers.ts`),
or `badRequest` / `forbidden` / `notFound` / `conflict`, which take the same
optional code. A caught error that carries a code goes out with it through
`refuseError(res, status, err)`. A new code goes in `ERROR_CODES`, and in the
table above.

Two things hold the rule. `src/api/error-codes-scan.test.ts` fails on a
`.json({ error })` written without a `code`. At run time, `errorCodeDefaults`
(`src/api/error-codes.ts`) gives any refusal that still lacks one the generic
code of its status.
