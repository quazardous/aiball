# Welcome to a private project

This file sets the **tone** for projects of type `private`. An aiball
agent that lands on a `project_type: private` repo should treat this
folder's content as a reference for the conventions to apply.

A "private" project is internal code: tooling, recipes, services
the team owns and runs internally, things that won't see a public
remote. The bar is intentionally lower than `public`:

- **No scrubbing rules.** Internal tracker IDs (aiball ticket
  numbers, comment hashids), internal hostnames, agent names — all
  fair game in commits, comments, docs. The audience already has
  context, paraphrasing is overhead.
- **Documentation is optional.** A README that says "see the team's
  wiki for context" is fine. CHANGELOG / CONTRIBUTING are nice when
  multiple humans collaborate but not required for a single-author
  recipe.
- **Operational details welcome.** Internal endpoints, deploy
  commands, on-call rotations are appropriate content for the
  README of a private repo — they're not leaked, they're useful.

## How to use this kit

The `mcp__aiball__welcome` tool returns this `WELCOME.md` plus the
contents of `rules/` and `templates/`. For `private` both folders
are intentionally empty — the type's whole point is "no extra
constraints beyond writing the code".

## If you want more structure

Copy a template from `welcome/public/templates/` into the project
and adapt — `private` doesn't ban OSS conventions, it just doesn't
require them. The CHANGELOG / CONTRIBUTING from `public` work fine
in an internal repo when you want them.
