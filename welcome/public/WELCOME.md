# Welcome to a public project

This file sets the **tone** for projects of type `public`. An aiball
agent that lands on a `project_type: public` repo treats this folder
as the reference for the conventions to apply.

A "public" project is code that lives on a public remote (GitHub,
GitLab, codeberg, …) — readable by anyone, contributable by anyone.

## Non-negotiables

Common ground with `private` (apply on every project regardless of
type):

- **Versioning + `CHANGELOG.md`** — track every notable change. Even
  pre-1.0 projects benefit from a chronological log.
- **Unit tests when feasible** — encouraged. Not strictly required,
  but anything you'd hate to break twice gets a test.
- **Secrets out of the repo** — `.env`, credentials, tokens stay
  out of version control. `.gitignore` covers them, and ideally a
  pre-commit secret scanner (gitleaks, detect-secrets, …) catches
  the mistake before it leaves the working tree.
- **Code in English** — identifiers (functions, variables, types,
  modules) are English. Universal, regardless of the team's
  spoken language.

Public-only additions:

- **English everywhere** — not just code, but also comments,
  docstrings, README, CHANGELOG, commit messages, PR descriptions.
  Mixing languages confuses contributors who don't speak the team's
  language. The bar is uniform.
- **Zero internal references** — the public artefacts must read
  cold for a stranger. That means no:
  - aiball ticket ids in any form: `#NNN`, `#B.NNN`, `aiball#NNN`,
    `aiball/NNN`.
  - aiball comment hashids: `#C.abc123`, `comment c6q9wr`.
  - aiball-specific commands: `aiball restart`, `ticket_engage`,
    `claude-loop`, etc.
  - aiball board URLs (`https://<host>/b/<id>`, Tailscale
    hostnames).
  - internal agent identities: `claude-aiball-dev`,
    `<project>-claude`, etc.
  - internal project names: `aiball`, `skybot`, `runic`, etc.
  - other internal infra hints: `*.internal`, `*.local` URLs,
    RFC1918 IPs in docs, dev paths (`/home/...`, `/Users/...`).
  Frame everything in terms the external reader can act on. Commit:
  `fix upstream chip rendering`, not `fix(aiball#160): upstream
  chip mangling`. Same fix, the public artefact loses the cross-
  reference that goes nowhere outside the tracker. The mirror lives
  on the ticket thread.
  A pre-commit grep / `gitleaks`-style scanner on these patterns is
  the right enforcement — exhortation alone forgets at the first
  pressed commit.
- **Self-contained documentation** — a newcomer reading the README
  understands what the project is and how to use it without opening
  another internal doc. "See CLAUDE.md" is fine in private; in
  public it's a dead link.
- **License the code** — every public repo carries a `LICENSE` at
  the root. No license = nobody can legally use the code, even if
  the README invites them to. MIT / Apache-2.0 / GPL are sane
  defaults — pick one deliberately.

## Record project rules in `CLAUDE.md`

This kit ships **starting** conventions — once an artefact lives in
the repo, the project owns its style and may have diverged on
purpose. The rendered files (CHANGELOG.md, CONTRIBUTING.md, …) are
the source of truth for the project's conventions; this kit is just
the bootstrap.

For **project-specific** rules that don't naturally fit in any of
the standard artefacts (preferred PR shape, deploy procedure,
internal-only architecture invariants, a custom commit-message
format, …), write them to a top-level `CLAUDE.md`. Claude Code
auto-loads it at session start, so incoming agents pick the rules
up natively without having to be reminded.

A minimal `CLAUDE.md` is fine — one short paragraph per rule, with
the *why*. Keep it terse ; if it grows past a screen, split into
linked docs under `docs/`. The point is to give the next agent
enough context to act consistently with the rest of the project
without re-asking.

## Tiebreaker

When a non-negotiable from the common ground appears to clash with a
public-specific rule, **public wins**. Example: the common rule
"comments in your usual language" coexists peacefully with "code in
English" — but for `public`, the public-specific "English
everywhere" overrides and pushes comments to English too.

## How to use this kit

The `mcp__aiball__welcome` tool returns this `WELCOME.md` plus the
templates shipped under `templates/`. The agent then:

1. Reads `WELCOME.md` first — that's the tone you're applying for
   the whole session on this project. Absorb it into your memory as
   project-wide invariants.
2. For each template, checks whether the equivalent file exists in
   the project. If missing, the agent reads the template (which
   starts with an HTML comment explaining intent), strips that
   intent comment, adapts the body to the project, and creates the
   file. If present, the agent leaves it alone — `welcome` is a
   guide, not a scaffolder that overwrites.
3. Templates ship with `<!-- intent: … -->` headers. They're for
   the agent's benefit only. **Drop the comment block before
   shipping** — it doesn't belong in the public artefact.

## Adding a new type

Drop a sibling folder under `welcome/<type>/` with a `WELCOME.md`
(required) and an optional `templates/` subfolder. The MCP tool
discovers it automatically — no code change needed. A folder
without `WELCOME.md` is considered a draft and stays invisible.
