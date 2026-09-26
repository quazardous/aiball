# The inbox row

`GET /api/inbox` returns the board as a plain array of rows, one per ticket,
computed **for the caller** (unread, turn and band depend on who asks). This page
is the row's contract.

**Row schema: version 2.** A field added keeps the version; a field removed or
whose meaning changes bumps it, and is listed under [Changes](#changes).

## Query

| Parameter | Effect |
|---|---|
| `project` | One project's tickets. |
| `ids` | Only these ticket ids (comma-separated). |
| `status` | Only tickets with this moderation status. |
| `open=1`, `unread=1` | Only open tickets; only tickets with something unread for the caller. |
| `intent`, `priority` | Only tickets with this intent, this priority. |
| `include_postponed=1` | Also snoozed tickets, hidden otherwise. |
| `view=turn` | Adds `turn`, `band`, `band_name` and `state_glyph` to each row ([below](#the-turn-view)). |
| `sort` | `activity` (default, latest first), `created_desc`, `created_asc`, `priority`, or `band` (by band, then latest activity). |
| `limit`, `offset` | A page; the total is in the `X-Total-Count` header. |

## Fields

**The ticket:**

| Field | Type | Meaning |
|---|---|---|
| `id` | number | The ticket id. |
| `project` | string | |
| `title` | string | |
| `snippet` | string \| null | The body's first 140 characters, whitespace collapsed. The full body is on `GET /api/tickets/:id`. |
| `by_agent` | string | The reporter. |
| `created_at` | ISO date | |
| `status` | `pending` \| `approved` \| `rejected` | Moderation status. |
| `intent` | `panic` \| `request` \| `question` \| `fyi` \| `feature` | |
| `priority` | `urgent` \| `high` \| `normal` \| `low` | |
| `level` | `task` \| `milestone` \| `roadmap` | |
| `milestone` | object \| null | The milestone this ticket belongs to. |
| `scope` | `internal` \| `default` \| `broadcast` | Who the ticket's events reach. |
| `tags` | array | `{ id, name, color, … }`. |
| `has_payload` | boolean | The ticket carries a payload. |
| `token_usage` | object \| null | Tokens spent on the ticket so far. |

**Its state:**

| Field | Type | Meaning |
|---|---|---|
| `closed` | boolean | Closed, or rejected at moderation. |
| `resolved` | boolean | Closed as done; stays true after the close. |
| `blocked` | boolean | |
| `postponed` | boolean | Snoozed, and the date has not come. |
| `postponed_until` | ISO date \| null | |
| `pending_plan`, `pending_resolution`, `pending_wontfix`, `pending_escalation` | boolean | The ticket's live decision is a proposal of this kind, awaiting a decision. False once closed. |
| `pending_decision_is_latest` | boolean | That proposal is still the thread's last word. |
| `latest_plan_rejected`, `latest_resolution_rejected` | boolean | The live decision of this kind was rejected. |
| `latest_is_step` | boolean | The thread's last word is a step (`then: continue`). |
| `step_resume_at` | ISO date \| null | When that step's author comes back. |
| `stalled_step` | boolean | That step has gone quiet longer than the project allows. |
| `critical` | object \| null | This is the project's critical ticket: `{ holds, quiet }`. |

**Activity, for the caller:**

| Field | Type | Meaning |
|---|---|---|
| `unread` | boolean | Something on the thread the caller has not seen. |
| `hot` | boolean | Recent activity by an agent, or a recent claim. |
| `comment_count` | number | |
| `pending_comment_count` | number | Comments awaiting moderation. |
| `last_activity` | ISO date | |
| `last_speaker` | string | Who wrote last (the reporter when nobody has commented). |

**Who holds it:**

| Field | Type | Meaning |
|---|---|---|
| `holder` | string \| null | Who holds the ticket **now**: the assignee, else the claimant while the claim is live. |
| `held_as` | `assigned` \| `claim` \| `lapsed_claim` \| null | How. `lapsed_claim`: a claimant is on record but the claim has expired, and `holder` is null. An assignment outranks a claim. |
| `assignee`, `assigned_at` | | The assignment on record. |
| `claimant`, `claimed_at` | | The last claim on record, live or not: read `held_as` to know. |

`GET /api/tickets/:id` carries the same `holder` and `held_as` in its header,
computed by the same rule, next to `is_claim` and `claim_until`.

## The turn view

`view=turn` adds three fields, computed by the server for the caller:

| Field | Values | Meaning |
|---|---|---|
| `turn` | `you` \| `them` \| `none` | Whose move it is. `them`: the caller acted last and someone else is involved, or the last word is someone else's step. `none`: closed. It follows the actionable rule (see `TICKET_LIFECYCLE.md`), not only the last comment: a decision taken or a close without a word hands the ball over. |
| `band` | number | Index into the bands below; `sort=band` orders by it. |
| `band_name` | string | The band's name, one of the bands below. Read this one: a band added or removed shifts the indexes, not the names. |
| `state_glyph` | see below \| null | The one state mark the row shows. |

**Bands**, in order:

| Index | Band | A row is here when |
|---|---|---|
| 0 | `moderate` | The caller is a moderator and the ticket, or a comment on it, awaits moderation. |
| 1 | `decision` | A proposal awaits a decision, and the caller did not make it. |
| 2 | `working` | The last word is a step, or the ticket is claimed and hot. |
| 3 | `open` | Any other open ticket. |
| 4 | `closed` | Closed. |

The first matching band wins. Unread is not a band: an unread ticket stays in
the band its work is in, and the row says it is unread (`unread`).

**`state_glyph`**, first matching:

| Value | When |
|---|---|
| `closed_resolved`, `closed` | Closed, as done or not. |
| `plan`, `resolution`, `wontfix`, `escalation` | A proposal of that kind awaits a decision. It outranks a later step. |
| `step_stalled`, `step` | The last word is a step, stalled or not. |
| `rejected` | The live plan or resolution was rejected. |
| null | None of the above. |

## Changes

- **Version 2.** The `unread` band is gone: an unread ticket keeps its
  workflow band, and `working`, `open` and `closed` move up one index. Adds
  `band_name`, the band's name next to its index.
- **Version 1.** First written version. Adds `holder` and `held_as`; the turn
  view is `view=turn` (it was `v=tvty`, which no longer adds anything).
