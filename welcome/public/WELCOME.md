# Welcome to a public project

This file sets the **tone** for projects of type `public`. An aiball
agent that lands on a `project_type: public` repo treats this folder
as the reference for the conventions to apply.

A "public" project is code that lives on a public remote (GitHub,
GitLab, codeberg, …) — readable by anyone, contributable by anyone.

> **Read me as bootstrap, not as authority.** This kit is the
> *starting* convention set, meant for early-stage projects. If
> you're calling `welcome()` on an established repo, the project has
> probably evolved — some divergences from this kit are deliberate
> (good reasons : team-specific preferences, OSS tooling change,
> performance trade-offs, dependencies dropped, …) and the project's
> own artefacts (CHANGELOG, CONTRIBUTING, CLAUDE.md, README) are the
> *current* authority. Cross-check before "correcting" anything to
> match this kit.
>
> Welcome is still useful on a mature repo : as a **reference** to
> spot accidental drift (a CHANGELOG that grew internal `#NNN` refs
> by inertia, a CONTRIBUTING that forgot to mention the test
> command, …), or as a **corrective** when the team agrees a past
> divergence was a mistake. Use it to *inform*, not to *enforce*.

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
- **No references to tools / artefacts the external reader can't
  reach.** Public artefacts must read cold for a stranger ; anything
  cited needs to be something they can actually follow. The criterion
  is *external visibility*, not "the word is internal-sounding". So :
  - **Forbidden** : private issue tracker IDs (`#NNN`, `JIRA-PROJ-12`)
    that point to a board no outsider can browse ; private chat / wiki
    URLs (`*.internal.*`, Tailscale / VPN-only hosts, intranet links) ;
    dev-machine paths (`/home/...`, `/Users/...`, `C:\Users\...`) ;
    internal-only agent / consumer identities, dashboards, runbooks.
  - **Allowed** : the project's own name (a public project naming
    itself is fine), upstream OSS dependencies, public GitHub issue
    / PR links, public docs URLs — basically anything someone reading
    cold can follow without credentials.
  Frame commits / CHANGELOG / README in terms the external reader
  can act on. Commit: `fix upstream chip rendering`, not
  `fix(JIRA-160): upstream chip mangling`. Same fix, the public
  artefact loses the cross-reference that goes nowhere outside the
  team. The mirror lives on the tracker thread.
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

1. Reads `WELCOME.md` first — that's the **starting** tone for the
   session. Absorb it as project-wide invariants.
2. **Immediately after**, opens the project's actual convention
   files to register any deviation from this kit (mandatory before
   any other action — see "Bootstrap, not authority" above) :
   - `CLAUDE.md` at the repo root if present — the project's
     primary place for rules that diverge from this kit OR that
     don't fit any standard artefact. Treat this as the **highest
     authority** for project-specific behaviour.
   - The top section of `CONTRIBUTING.md` if present — code style,
     PR conventions, test commands.
   - The persistent header / quote block at the top of
     `CHANGELOG.md` — house style for entries, bump conventions.
   The result is the agent's working baseline for the session :
   *kit conventions, overridden by anything the project explicitly
   states in those files.* When in doubt, the project's file wins.
3. For each template, checks whether the equivalent file exists in
   the project. If missing, the agent reads the template (which
   starts with an HTML comment explaining intent), strips that
   intent comment, adapts the body to the project, and creates the
   file. If present, the agent leaves it alone — `welcome` is a
   guide, not a scaffolder that overwrites.
4. Templates ship with `<!-- intent: … -->` headers. They're for
   the agent's benefit only. **Drop the comment block before
   shipping** — it doesn't belong in the public artefact.

## Adding a new type

Drop a sibling folder under `welcome/<type>/` with a `WELCOME.md`
(required) and an optional `templates/` subfolder. The MCP tool
discovers it automatically — no code change needed. A folder
without `WELCOME.md` is considered a draft and stays invisible.
