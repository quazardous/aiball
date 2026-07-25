# Upstream coupling (GitHub / GitLab)

aiball tickets can be **coupled** to external issues (GitHub today; GitLab /
Gitea are additional drivers later). Coupling is always a **manual, one-gesture
act** — there is no auto-discovery and no timer that scoops issues into your
board. A ticket with no coupling is a pure aiball ticket the driver never
touches, so your aiball-only tickets stay exactly as they are.

Two layers exist:

- **Reference rendering** (always on) — write `gh#1160` in a ticket body and it
  renders as a clickable chip, resolved through the per-project `upstream:`
  binding below. Pure rendering: no API calls.
- **Coupling** (opt-in per ticket) — actually link an aiball ticket to an
  external issue and carry state between them. This page covers the coupling
  driver.

## Configure

### 1. Point a project at a repo (optional, for the bare `gh#N` form)

In the project's `.aiball.yaml` (or the global config), declare a binding so
the bare `gh#N` form knows which repo it means:

```yaml
upstream:
  my-project:
    - kind: github
      ref: github:owner/repo
      default: true        # at most one default per (provider, prefix)
```

With a default binding, `gh#123` resolves to `owner/repo#123`. Without one, use
the self-contained explicit form `gh:owner/repo#123` — no binding required.

### 2. Provide an API token (for private repos / higher rate limits)

A token is a **host-level credential**, so it lives in the GLOBAL config
(`~/.config/aiball/config.yaml`), never in a committable per-project
`.aiball.yaml`:

```yaml
upstream_auth:
  github:
    token: ghp_xxx
```

Env fallback (handy for CI / one-off runs): GitHub reads `GITHUB_TOKEN`, then
`GH_TOKEN`. Public repos import unauthenticated (subject to GitHub's rate
limits).

## Import an external issue

Fetch an issue and create a coupled aiball ticket from it. The ticket takes the
issue's title/body, its labels become aiball tags, and the link (provider / ref
/ number) is recorded on the ticket.

- **CLI**

  ```console
  aiball ticket import gh#123                 # needs a default binding
  aiball ticket import gh:owner/repo#123      # self-contained
  aiball ticket import gh#123 --project my-project
  ```

- **MCP** — `ticket_import({ ref: "gh:owner/repo#123", project? })`

- **HTTP** — `POST /api/tickets/import` with `{ "ref": "...", "project": "..." }`

Import is **idempotent**: re-importing an issue that's already coupled fails
(HTTP 409) and points you at the existing ticket instead of forking a
duplicate. Pull requests are refused (their lifecycle differs from an issue's).

## What's not here yet

Coupling is being built in slices. Landed today: manual import. Planned next:

- **Export** — push an aiball ticket up as a new GitHub issue (behind a
  confirming action, since it writes to the remote).
- **Background sync** — a poller that keeps state and labels/tags in step on
  *already-coupled* tickets (including closing a ticket when its upstream issue
  closes). Conflicts resolve with one authoritative direction per link, not a
  silent merge.
- **More providers** — GitLab / Gitea as additional drivers.

See [`ROADMAP.md`](../ROADMAP.md) for the full direction.
