# Welcome to a public project

This file sets the **tone** for projects of type `public`. An aiball
agent that lands on a `project_type: public` repo should treat this
folder's content as a reference for the conventions to apply.

A "public" project is code intended to live on a public remote
(GitHub, GitLab, codeberg, …). The bar is:

- **Self-explanatory README** — a stranger arriving cold understands
  what the project is and how to use it within the first screen.
- **Standard OSS scaffolding** — `README.md`, `LICENSE`,
  `CHANGELOG.md`, `CONTRIBUTING.md` use widely-recognised formats
  ([Keep a Changelog](https://keepachangelog.com),
  [SemVer](https://semver.org), etc.) so contributors and tooling
  don't need to learn project-specific conventions.
- **No internal tracker leakage** — see `rules/no-aiball-refs.md`.
  References to aiball ticket ids, internal Slack channels, private
  hostnames etc. don't belong in public artefacts (commit messages,
  PR titles, code comments, README, …).
- **License everything** — every public repo carries a `LICENSE` file
  at the root. No license = nobody can use the code, even if it
  looks permissive.

## How to use this kit

The `mcp__aiball__welcome` tool returns this `WELCOME.md` plus the
contents of `rules/` and `templates/` for the project's type. The
agent then:

1. Reads the rules — they're meant to be absorbed into the agent's
   persistent memory (= "always apply on this project").
2. For each template, checks whether the equivalent file exists in
   the project. If missing, the agent reads the template (which
   starts with an HTML comment explaining intent), adapts it to the
   project, and creates the file. If present, the agent leaves it
   alone — `welcome` is a guide, not a scaffolder that overwrites.

## Adding a new type

Drop a sibling folder under `welcome/` with the same structure
(`WELCOME.md` + `rules/` + `templates/`). The MCP tool discovers it
automatically — no code change needed.
