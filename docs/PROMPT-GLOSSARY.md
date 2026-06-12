# Prompt glossary

The vocabulary used in agent-facing surfaces — `claude-loop` wake
phrases, the aiball MCP tool descriptions, the skill, the welcome
templates. Pin the canonical mapping `verb → MCP tool` so wording stays
unambiguous across the prompt surface.

## Rule of thumb

**Verb = tool**. When a surface describes an action an agent should
perform, the verb is the MCP tool name (or a clear prefix). Anything
else is either documentation prose or a human-only signal — never an
implicit action.

## Canonical actions

| Verb | MCP tool | What it does |
|------|----------|--------------|
| `claim` | `ticket_claim` | Take focus on a ticket. The agent currently working on it. |
| `release` | `ticket_release` | Drop the claim. |
| `reply` | `ticket_reply` | Post a comment on a ticket thread. |
| `decide` | `ticket_decide` | Approve / reject a pending post (moderation override). |
| `list` | `ticket_list` | Query the work-order. |
| `get` | `ticket_get` | Read a single ticket (header / brief / digest / full). |
| `search` | `search` | Full-text query across tickets + comments. |
| `subscribe` | `subscribe` / `unsubscribe` | Add / remove a ticket subscription. |
| `new` | `ticket_new` | File a new ticket. |
| `move` | `ticket_move` | Re-parent / re-project a ticket. |
| `relate` | `ticket_relate` / `ticket_unrelate` | Link two tickets via a typed relation. |
| `upload` | `upload` | Attach a file (image / artifact) to a comment. |
| `poll` | `poll` | Fetch the agent's status snapshot (queue depth, daemon health). |
| `unread` | `unread` | List unread pings. |
| `welcome` | `welcome` / `welcome_template` | Pull the project onboarding kit. |
| `arbitrate` | `arbitrage` | File a cross-project arbitration ask. |

## Decision verbs (attached to a `ticket_reply` via the `then:` field)

| `then:` | What it proposes |
|---------|------------------|
| `plan` | Approach for HOW the ticket will be tackled — accept = greenlight to execute. |
| `resolved` | Work shipped, propose to close. |
| `wontfix` | Close without shipping (junk / out of scope / unreproducible). |
| `escalate` | Blocker requires a HUMAN action the agent can't perform. |
| `close` | Reporter-only direct close. |
| `reopen` | Bring a closed ticket back. |

## Human-only catchphrase pool

These words are reserved for human-typed greenlights — they mean
*"execute the proposal I just made"*. They **never appear in wake
templates** and **must not be re-used as agent action verbs**.

- Engage
- Make it so
- Geronimo
- Yabba dabba doo
- Pop quiz hotshot
- Allons-y

When the human types one of these in a comment, the agent acts on the
default it just proposed and moves on — the catchphrase IS the ack.

## Idle pings (decoration, NOT action)

These words appear in the random `ping_messages` pool. They signal
*"heads up, the loop is alive"* — they carry **no action verb**.

- Beep boop
- Hodor
- *tap tap*

If a wake phrase pulled from `ping_messages` would land on a word that
implies an action, that word leaks the meaning and the agent reads it
as a CTA. The pool is curated to stay action-free ; new entries follow
the same constraint.

## Ambiguous words to avoid

These words have shipped at various points and turned out to confuse
the agent. Replace on sight.

- **engage** (as a verb) — reserved for the human catchphrase. Use
  `claim` for "take a ticket", `address` / `pick up` (prose only) for
  generic "interact with".
- **work on** / **take** / **pick up** / **handle** — use `claim`
  when describing the MCP action. These are fine in human prose
  (skill documentation, comments) but never in tool descriptions or
  wake phrases.
- **drain** — the agent reads it as "consume the FIFO unconditionally",
  which was a footgun (the wake injection is the single source of
  pacing). Drop / replace with `act on the wake's head`.

## How to extend this glossary

When you add a new MCP tool or a new prompt surface :

1. Pick a single canonical verb. Prefer the tool name's prefix.
2. Make sure the verb isn't already in the catchphrase pool.
3. Make sure the verb isn't in the ambiguous list.
4. Add a row here.

When you spot an ambiguous word in a shipped surface :

1. Read the surrounding context — is it agent-facing or human prose ?
2. If agent-facing : swap to the canonical verb from the table above.
3. If human prose : leave it, or note here why the ambiguity is
   load-bearing in that context.
