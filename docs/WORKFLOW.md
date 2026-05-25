# Workflow — `feature` vs mainstream

aiball's dev checkout **is** the live runtime: `~/.local/lib/aiball` symlinks to
it, `bin/*` run the source via `tsx` (no build), and the daemon is `tsx watch`.
So how the agent works is driven by the ticket's **`intent`**, and one rule is
absolute: **the agent never switches the runtime checkout's branch.**

## Two postures, driven by ticket `intent`

| `intent` | posture | where the agent works |
|---|---|---|
| `feature` | isolated — iterate boldly, validate → merge | a **dedicated branch + PR**, in a **git worktree** (never the runtime checkout) |
| `request` (default), `panic`, `question`, `fyi` | mainstream — live | edit **`main` in place**, small always-green increments |

- **`feature`** = code work built in isolation: a branch + PR, reviewed, then
  merged. Use a worktree so the runtime checkout never leaves `main`.
- **mainstream** (everything else) = edit `main` directly. It's live in the
  runtime immediately (backend via tsx; rebuild the frontend for UI). Keep
  `main` green with small commits.

## The absolute rule

**Never `git checkout` / switch the branch of the runtime checkout.** A branch
switch there silently changes david's live runtime (and blips the daemon).
`feature` work goes in a **separate worktree**; mainstream edits `main` in
place. The runtime checkout always shows a stable `main`.

## The wake hint (claude-loop)

For a `feature`-intent ticket, claude-loop appends a branch hint to the wake
prompt, e.g. `🌿 Feature: build it in a dedicated branch + PR, not on main.`
The wording is **config-driven** via the layered `.aiball.yaml`:

```yaml
workflow:
  hint_branch: false    # hint a dedicated branch + PR (default off — opt in)
  hint_worktree: false  # also mention a worktree (default off — too technical)
```

**Both default to `false`** → no branch hint on feature wakes unless a project
opts in. `request`/other intents never get a workflow hint.

## Deploy reality

- **Backend** (tsx) is live the moment it lands on the runtime checkout's `main`.
- **Frontend** needs `npm run build` (dist is gitignored) to deploy UI changes.
- A **migration** is applied by the daemon on reload (boot-migrate); make sure
  it's applied before the dependent query goes live.

## Persistence / permissions

Direct `git push origin main` and `gh pr merge` are gated by the permission
classifier. Persist via a **feature-branch PR** (then merge). A Bash permission
rule for `git push origin <branch>` + `gh pr merge` would make a standing "go".
