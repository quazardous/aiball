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

### 2. Choose how aiball reaches GitHub

Two wires carry the same calls:

- **`gh`** — runs the GitHub CLI, which brings its own credential from your
  keyring. Reaches private repos with **no secret stored in any aiball config**.
  Requires `gh` installed and `gh auth login` done.
- **`http`** — talks to the API directly. Always available; without a token it
  sees public repos only, at a lower rate limit.

By default aiball picks for you (`auto`): it uses `gh` when that CLI is
installed and authenticated, otherwise `http`. The choice is made once per run
and logged, so you can always tell which wire was used. Pin it host-wide in the
GLOBAL config if you'd rather decide:

```yaml
upstream_transport: gh    # auto (default) | gh | http
```

…or per repo, when one binding needs a different wire than the rest:

```yaml
upstream:
  my-project:
    - kind: github
      ref: github:owner/repo
      transport: gh
      default: true
```

**A pinned wire is never silently swapped.** If you ask for `gh` and it isn't
usable, calls fail with a message saying so — they don't quietly fall back to
`http`, because that would hide a broken `gh` until the day both break.
`aiball check` shows the resolved wire and probes each one.

### 3. Provide an API token (only for the `http` wire)

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
limits). On the `gh` wire you need none of this — the CLI's own credential is
used.

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

## Export an aiball ticket

Push an existing aiball ticket UP as a **new** GitHub issue and couple the
ticket to it. This **writes to the remote** (it creates a public issue), so the
surfaces gate it behind an explicit confirmation.

- **CLI** — requires `--yes` (the write is irreversible):

  ```console
  aiball ticket export 123 --yes                     # uses the project's default binding
  aiball ticket export 123 --repo owner/repo --yes   # explicit target
  ```

- **MCP** — `ticket_export({ ticket_id, repo? })` (the deliberate call is the
  confirmation).

- **HTTP** — `POST /api/tickets/:id/export` with an optional `{ "repo": "..." }`.

The target repo is the project's default `github` binding unless you pass an
explicit `repo`. Export writes to the remote, so it needs write credentials: on
the `http` wire that means a **write-scoped token**, while the `gh` wire uses
the CLI's own login. A ticket that is already coupled is refused — unlink it
first rather than forking a second remote issue.

## Watching a coupled issue

Once a ticket is coupled, aiball keeps an eye on the issue — **without copying
it**. The ticket keeps its own title and body; nothing upstream ever overwrites
them. Every ten minutes each coupled ticket is checked, and when the issue has
moved since the last check, a single note lands in the thread:

> **Updated upstream** — `gh#86` was **closed** by **someone**.
> → https://github.com/owner/repo/issues/86

That's the whole mechanism: a pointer, not a mirror. The note quotes just enough
to decide whether to go look, links out, and brings the ticket back into your
actionable list. It is posted by `__system:upstream`, an identity that holds no
token and takes no assignment.

The first check after coupling is deliberately silent — it only records where
the issue stood, so enabling the watch doesn't announce every long-standing
coupling at once.

Turn it off host-wide or per repo:

```yaml
upstream_sync: off        # global config: pull (default) | off
```

```yaml
upstream:
  my-project:
    - kind: github
      ref: github:owner/repo
      sync: off           # this repo is linked, but not watched
      default: true
```

A check that fails records the error against the ticket instead of retrying
silently, and does **not** advance its watermark — so the change it failed to
read is announced on the next successful check rather than lost.

## What's not here yet

Coupling is being built in slices. Landed today: manual import + export.
Planned next:

- **Pushing back up** — sending an aiball comment to the coupled issue. It stays
  an **editorial gesture**, one comment at a time, never a background loop: what
  leaves your board towards a public issue is chosen, not scheduled.
- **More providers** — GitLab / Gitea as additional drivers.

Deliberately **not** planned: mirroring an issue's title, body or comments into
the ticket. Coupling links the two; it does not duplicate one into the other,
and that is what keeps conflicts, divergence and "which side wins" off the
table entirely.

See [`ROADMAP.md`](../ROADMAP.md) for the full direction.
