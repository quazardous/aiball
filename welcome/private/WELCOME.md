# Welcome to a private project

This file sets the **tone** for projects of type `private`. An aiball
agent that lands on a `project_type: private` repo treats this folder
as the reference for the conventions to apply.

A "private" project is internal code: tooling, recipes, services
the team owns and runs internally, things that won't see a public
remote.

## Non-negotiables

Common ground with `public` (apply on every project regardless of
type):

- **Versioning + `CHANGELOG.md`** — track every notable change.
- **Unit tests when feasible** — encouraged.
- **Secrets out of the repo** — `.env`, credentials, tokens stay in
  ignored files. A pre-commit secret scanner is a good safety net.
- **Code in English** — identifiers (functions, variables, types,
  modules) are English. Universal even when the spoken language is
  not.

Private-only relaxations:

- **Comments / docstrings / commit messages can be in the team's
  usual language.** Code stays English ; the prose around it does
  not have to. A team that thinks in French keeps the friction low
  by writing comments in French.
- **Internal references are fine.** Internal tracker ids
  (`aiball#NNN`), internal project names (`aiball`, `skybot`,
  `runic`), internal URLs (`*.internal.*`, Tailscale hostnames),
  even on-call dashboards — all appropriate in code comments,
  README, runbooks. The audience already has the context, no need
  to paraphrase.
- **Operational details welcome in the README** — deploy commands,
  internal endpoints, on-call rotations. They're not leaks; they're
  useful for whoever picks this up next.

## Watch the migration debt

Choosing `private` is a deliberate trade-off : if this project ever
goes public later, expect a scrub pass — French comments to
translate, internal references to remove, README to rewrite. The
cost grows with the codebase, so the decision to keep a project
private should be a real one, not a default.

If you suspect a "private for now, maybe public later" trajectory,
consider applying the `public` discipline (English everywhere,
no internal refs) preemptively. It's cheap on day 1, expensive
to retrofit on a 200-commit history.

## Record project rules in `CLAUDE.md`

This kit ships **starting** conventions — once an artefact lives in
the repo, the project owns its style and may have diverged on
purpose. Whatever's in the rendered files is the project's voice ;
this kit is just where it bootstrapped from.

For **project-specific** rules that don't fit in a standard artefact
(internal architecture notes, deploy procedure, in-house commit
format, on-call escalation, …), write them to a top-level
`CLAUDE.md`. Claude Code auto-loads it at session start, so incoming
agents pick the rules up natively — no welcome detour, no manual
reminder. On a `private` project the file can be as verbose and
internal-jargon-heavy as the team needs.

## Tiebreaker

When a non-negotiable from the common ground appears to clash with
a private relaxation, **the common-ground rule wins** — for `public`
projects it's the reverse (public wins). Concretely: `code in
English` is common ground and applies on `private` even though
comments can be in another language.

## How to use this kit

The `mcp__aiball__welcome` tool returns this `WELCOME.md`. The
`templates/` folder is intentionally empty — the type's whole
point is "no extra constraints beyond writing the code, just the
non-negotiables above".

If you want more structure on a `private` project, copy a template
from `welcome/public/templates/` and adapt — `private` doesn't ban
OSS conventions, it just doesn't require them.
