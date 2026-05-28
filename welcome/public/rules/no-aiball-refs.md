<!--
intent: prevent leakage of the internal aiball tracker into anything
that lands on the public remote. The tracker IDs (`#NNN`,
`#C.<hashid>`), aiball-specific commands (`aiball restart`,
`ticket_engage`, …), and references to aiball board URLs are signals
that don't belong in artefacts visible to external readers.
-->

# No aiball-tracker leakage in public artefacts

## Rule

Do not include references to the **aiball** ticket tracker in any
content that ends up on the project's public remote (GitHub
issues/PRs, commit messages, code comments, README, CHANGELOG,
documentation, source files).

This covers:

- aiball ticket IDs: `#123`, `#B.123`, `aiball#123`, `aiball/123`,
  `#NNN ticket`, etc.
- aiball comment hashids: `#C.abc123`, `comment c6q9wr`, etc.
- aiball commands: `aiball restart`, `ticket_engage`, `ticket_reply`,
  `claude-loop`, etc.
- aiball board URLs: `https://<host>/b/<id>`, `tailscale.ts.net/b/…`.
- Internal agent names: `claude-aiball-dev`, `<project>-claude`,
  `aiball-win`, etc.

## Why

The aiball board is not public. References to it are dead links from
the outside, and they hint at internal infrastructure (Tailscale
hostnames, agent topology) that doesn't need to be exposed.

## How to apply

When writing for the public remote, frame everything in terms the
external reader can act on:

- Commit message: describe the **change**, not the ticket. `fix
  upstream chip rendering` rather than `fix(aiball#160): upstream
  chip mangling`.
- PR description: link the upstream issue tracker (GitHub
  issues, if any) — not the aiball ticket. If you genuinely need to
  cite something internal, paraphrase its substance instead of
  pointing.
- Code comments: explain WHY in terms a reader from the outside can
  understand. `# legacy workaround for the lockstep race` not `# see
  aiball#412 yvth6d`.
- README / CHANGELOG: never mention aiball at all.

## Mirror in CHANGELOG vs ticket thread

The CHANGELOG audience is external; the ticket thread audience is
internal. Same change, two write-ups:

- CHANGELOG entry: `Fixed: cursor positioning on Windows terminals
  when the snapshot did not carry an explicit move escape.`
- Ticket reply: `Shipped abc1234 — diag: psmux capture-pane omits the
  cursor positioning escape vs tmux; fix in src/pane.ts: emit
  display-message in parallel […]`.

The CHANGELOG line lives forever in the public repo. The ticket
reply lives in the aiball board.
