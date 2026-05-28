# Contributing to aiball — agent + dev guide

Single entry point for **how we work on this codebase**. The audience is
both human contributors and the Claude agents that drive most of the
work (aiball-win on Windows, claude-aiball-dev on Linux, etc.).

The repo's [`README.md`](../README.md) tells you what aiball *is*; this
doc tells you how to *change* it. Operational instructions for the dev
checkout (the live runtime, frontend rebuild, hard restart for
migrations…) live in [`CLAUDE.md`](../CLAUDE.md) — load it first, then
come back here for the *how*.

## Sections

1. [Multi-agent norms](#1-multi-agent-norms) — how agents collaborate via aiball tickets
2. [Code style](#2-code-style) — language, commits, branches, migrations, tests
3. [Doc style](#3-doc-style) — reader-facing vs internal, refs policy, CHANGELOG flow
4. [Agent kit](#4-agent-kit) — what to preload, what to look up, what to remember

---

## 1. Multi-agent norms

aiball is built by a small fleet of Claude agents working in parallel
on a shared codebase. The norms below make sure two agents don't fight
over the same ticket, that handoffs survive context resets, and that
humans can read the audit trail tomorrow.

### 1.1 The aiball ticket IS the channel

Tickets are not a side-bar to the work — they are the work surface.

- **Decisions and rationale live on the thread**, not in a chat window
  that disappears at session end. If a decision shaped the code, the
  thread should explain why.
- **Status snapshots live in `summary_until`** on every reply (see
  [Brief reads + `summary_until`](#15-summary_until-state-not-action)
  below). A future agent who reads only the pivot snapshot + the
  latest body should be able to resume.
- **Inter-agent communication uses comments** (`ticket_reply`), not
  out-of-band messaging. The other agent sees it via their ping inbox,
  the human sees the same trail.

Conversation prompts from the human ARE valid inputs (the loop relays
them as wake messages), but anything the human decides via a ticket
comment is also authoritative — both feed the same agent.

### 1.2 Intents and priorities

`ticket_new` takes an `intent` that frames what's expected:

| Intent     | Meaning                                                      |
| ---------- | ------------------------------------------------------------ |
| `panic`    | Immediate blocker, drop other work                           |
| `request`  | Action expected (default)                                    |
| `question` | Needs an answer, not necessarily code                        |
| `fyi`      | Informational, no action expected                            |
| `feature`  | Isolated code work — branch + PR per [#319]                  |

Orthogonal to intent, `priority` (#B.222) is the urgency hint:
`urgent` / `high` / `normal` / `low`. Most tickets are `normal` — pick
the others deliberately. Priority influences `ticket_list` sort, ping
ordering, and the work-order returned by `ticket_engage`.

### 1.3 Claim discipline

A ticket can be **assigned** (durable ownership recorded on the row)
and/or **claimed** (live, recent intent-to-work signal — drops out of
other agents' actionable pool, see #418).

- **`ticket_engage`** is the canonical work-pick tool. It returns the
  head of *your* claimable queue and stamps a claim on it in one call.
  Use it instead of `ticket_list` when you're actually about to do
  something — `ticket_list` is the read-only exploration tool.
- **`no_claim` consumers** (set per-project via `.aiball.yaml`) get
  `engaged: null` and just listen — they comment / handoff but never
  claim. Useful for relay or observer agents.
- **Release the claim** when you're done with the actionable surface
  (PR open and awaiting review, or work shipped). Don't hold a claim
  across long idle waits — it blocks the work-order for everyone else.
  `ticket_release` is the explicit call.
- **Re-engaging** a ticket you already hold is idempotent — just
  refreshes the claim window.

### 1.4 Hot, own-claim, presence

Three independent signals on a ticket; understand the difference so
you don't conflate them:

- **`r.hot`** — cross-agent recency. Any agent's activity in the last
  ~10 min (`hot_window_sec`, configurable) bumps the ticket as hot for
  the visibility layer (the 🔥 indicator). Humans don't make tickets
  hot (#408). Recency only — a stale claim does not keep a ticket hot
  (#532).
- **own-claim** — your live claim on the ticket. Sorts above hot in
  the work-order (#430): explicit intent beats implicit recency.
- **`present`** — your loop is currently holding an SSE connection
  (the loop's process liveness signal, #395). Drives the running
  badge and unlocks live-only operations (e.g. inject prompt).

Hot is a *display + tiebreak* signal. Own-claim is a *coordination*
signal. Presence is a *liveness* signal. They don't replace each
other.

### 1.5 `summary_until`: state, not action

Every agent `ticket_reply` MUST carry `summary_until` (the API rejects
without it). This is **not** a recap of what you just did — it's the
**ticket state snapshot after this comment lands**, written so the
next agent (or you in a future session) can resume from just that
line.

Good (state-framed):

- `Awaiting david accept on PR #38 (timer resilience fix). CI green; no regressions noted in review.`
- `Phase B.2 shipped; next step is migration backfill on tokens.label.`

Bad (action-framed — describes what *you* did, belongs in the body):

- `Pushed PR #38 with the timer fix.`
- `Refactored everything as discussed.`

If a human reads only this single line plus the latest body, they
should know what's open and who owes what. Keep it sharp.

### 1.6 Handoffs

Three mechanisms, pick the right one:

- **`@-mention`** in a comment — soft handoff: the other agent gets a
  ping but the claim doesn't transfer. Use when you want a second
  opinion or to delegate a specific sub-task. Mention with their full
  consumer id (`@claude-aiball-dev`, `@aiball-win`).
- **`ticket_assign`** — formal ownership transfer. Use when the work
  legitimately belongs to a different agent (different host, different
  expertise). Releases any existing claim per #523.
- **`then: resolved` / `then: plan`** on the comment — proposes a
  decision. `resolved` = "I claim this is done, please accept." `plan`
  = "Here's HOW I'd tackle this, please validate before I execute."
  The reporter sees an accept/reject pair. Auto-accepted when the
  ticket is closed by the reporter.

Don't `@` an agent if you don't expect them to act — use a plain
comment. The ping notifications respect the mention semantics.

### 1.7 Sub-tickets vs comments

Open a sub-ticket (`ticket_new` with `parent_ticket_id`) when:

- The work has its own distinct deliverable (a separable PR, a
  separate review cycle).
- You want a separate `summary` line in the inbox.
- The scope is wide enough that mixing it into the parent thread
  would bury the existing discussion.

Stay in the parent thread when:

- The follow-up is atomic: one comment, one decision, done.
- The discussion is still converging on what to do.

A parent ticket's UI surfaces its sub-tickets list, so the linkage
stays visible.

### 1.8 Scope (`internal` / `default` / `broadcast`)

`scope` on `ticket_new` and `ticket_reply` controls fan-out (#B.245):

- `internal` — owners only + explicit `@`-mentions. Use for sensitive
  or owner-only coordination.
- `default` — ticket subscribers + project owners + mentions. The
  normal case for reply traffic (#253).
- `broadcast` — `default` + project followers. Use when the ticket
  surface is API-impacting or otherwise interests followers.

Each comment decides its own fan-out independently.

### 1.9 What lives in tickets vs code comments vs commit messages

Triage based on audience:

- **Ticket thread**: rationale, alternatives considered, who decided
  what, links to other tickets / PRs. Internal numbers (`#532`,
  hashids) are fine here.
- **Code comment**: WHY the code is non-obvious (a hidden invariant,
  a workaround for a specific bug). Reference a ticket only when the
  code itself can't tell the future reader the *why*. See
  [§ 2 Code style](#2-code-style) on comment policy.
- **Commit message + PR body**: WHY this change. Use ticket refs
  (`fix(#530 cerqc8): …`) — internal context is appropriate for
  release history. Reader-facing docs stay clean of these refs.

Deep dives on the lifecycle and event model live in
[`docs/TICKET_LIFECYCLE.md`](TICKET_LIFECYCLE.md).

---

## 2. Code style

### 2.1 Language: English

**All code is in English** — comments, identifiers, log messages,
string literals, error messages, test names. UI strings shown to the
end user are also English (the project has no i18n surface today; see
[`docs/I18N.md`](I18N.md) for the policy + the proposed approach if
that ever changes).

This applies to new code AND to edits you make to existing code: if
you touch a file with French legacy comments, you don't have to
retranslate the whole file, but anything you *write* is in English.
The legacy French slowly disappears as files are revisited.

(Older agent guidance said "code comments are French" — that's stale
since david switched to English. This doc is now the source of
truth.)

### 2.2 Comments: default to none

The default is to write **no comment**. A well-named identifier and a
small function are self-documenting.

Write a comment only when:

- The WHY is non-obvious — a hidden constraint, a subtle invariant,
  a workaround for a specific bug, behavior that would surprise the
  next reader.
- A ticket exists that explains the choice and would help someone
  understand the code's surrounding context. Reference it with the
  ticket number (`#530`) and optionally the comment hashid that
  carries the decision (`d8ghfz`). The reader can look it up.

Don't write comments that:

- Restate what the code does (`// increment counter`).
- Reference the current task ("added for the X flow", "used by Y").
  That belongs in the PR description and goes stale fast.
- Explain to future-you that you "tried Z first and it didn't work."
  That belongs in the ticket thread.

One-line max in almost every case. Multi-paragraph docstrings or
multi-line comment blocks are noise unless you're documenting a
genuinely complex algorithm — and even then ask whether refactoring
to make the code clearer is the better fix.

### 2.3 No premature scope

When fixing a bug, fix the bug. When adding a feature, add the
feature. Resist:

- "While I'm here" surrounding-cleanup commits in the same PR. Open a
  separate PR for cleanup if it's worth doing.
- New abstractions for hypothetical future requirements. Three similar
  call sites is better than a premature abstraction.
- Error handling for scenarios that can't happen. Trust internal code
  and framework guarantees. Validate only at system boundaries (user
  input, external APIs).
- Backwards-compat shims when you can just change the code (this
  codebase is single-deployment; there are no clients to keep happy).

### 2.4 Commits, branches, PRs

**Commit messages** follow conventional-commits style with ticket
refs:

```
fix(#530 cerqc8): swap line-height for padding-bottom to avoid FF/Linux inflation

PR #35 added `line-height: 1.5` to fix the descender clip on Segoe UI
/ Windows Chrome. On FF/Linux where the default line-height computed
is more generous, 1.5 visibly inflated the rows (david `qx3vuq`).
[...]
```

- Prefix with `fix(...)`, `feat(...)`, `docs(...)`, `ci(...)`, etc.
  matching the change type.
- Ticket ref `#NN` in the prefix when one applies, optionally with
  the comment hashid (`#530 cerqc8`) when the trigger was a specific
  comment. Internal refs are fine in commit messages (release
  history is internal-audience).
- Body explains WHY, not WHAT. The diff already says what.

**Branch naming**: `feat/<scope>`, `fix/<scope>`, `docs/<scope>`,
`ci/<scope>`. The scope is short and descriptive (`fix/timer-resilience`,
`docs/contributing`, `ci/cl-pty-proxy-windows-build`). Numeric ticket
prefix optional (`fix/537-mobile-project-picker-split` is fine when
the ticket is the main driver).

**One PR per logical scope**. If you find yourself opening two PRs
because "they're related," stop — most of the time the right move is
a single `feat/<scope>` branch with one PR. Stacked tiny PRs are
churn. (David explicitly prefers this.) Exception: when the work has
genuinely independent deliverables that can land at different times
(see [§ 1.7 Sub-tickets vs comments](#17-sub-tickets-vs-comments)).

**Don't skip hooks.** `--no-verify` is off-limits unless the user
explicitly asks. If a pre-commit hook fails, fix the issue and create
a NEW commit — never amend a commit the hook already rejected (the
commit didn't land, so `--amend` would mutate the *previous* commit
and likely destroy work).

### 2.5 Migrations

Touching the schema needs care because the dev checkout IS the live
runtime — see `CLAUDE.md` § "How this checkout runs."

The hard rule: **apply the migration via `aiball restart` BEFORE
committing the code that reads the new column.** Otherwise the live
daemon crashes on reload (`tsx watch` reloads code but does NOT
re-run migrations — a hard restart does).

Full conventions, journal entries, naming, the `drizzle-kit generate`
flow: see [`docs/MIGRATIONS.md`](MIGRATIONS.md). When touching DB,
preload that doc.

### 2.6 Tests

aiball uses Node's native test runner (`vitest`-style suites under
`src/**/*.test.ts` and `frontend/src/**/*.test.ts`).

- Add a test when fixing a bug that has a stable repro (the test
  guarantees we don't regress).
- Add a test when shipping a new public API surface (the contract
  needs locking in).
- Don't add a test for code you can't reach from a test (UI visual
  rendering, OS-specific PTY behavior). Note the gap in the PR.
- Keep tests fast — anything > 100 ms per case warrants a comment
  explaining why.
- Run `npm test` (root) before pushing a PR. CI (`#527`) covers Rust
  on Windows; Node tests still run locally and on the upstream when
  enabled.

Skipping a test (`.skip`, `xfail`) is acceptable as a tracker for a
known follow-up — but write down the WHY and the condition for
unskipping in a comment or a ticket, otherwise the skip rots and
becomes silent dead weight.

## 3. Doc style

### 3.1 Reader-facing vs internal

aiball's docs split by audience, and the audience changes the rules:

| Surface                                  | Audience           | Internal refs (`#NN`, hashids) | Tone        |
| ---------------------------------------- | ------------------ | ------------------------------ | ----------- |
| `README.md`, `ROADMAP.md`, `MCP-CLIENT.md`, `docs/*.md`, `.aiball.yaml.example` | Public / users     | **No**                         | Tutorial    |
| `CHANGELOG.md`, `CLAUDE.md`, this doc    | Internal           | Yes                            | Telegraphic |
| Ticket threads, code comments            | Internal           | Yes                            | Free-form   |
| Commit messages, PR bodies               | Internal (history) | Yes                            | Imperative  |

The aiball ticket board isn't public, so `#530` / `#B.130` /
hashids mean nothing to a reader. Keep them OUT of the reader-facing
surfaces — link to behavior or cite a doc section instead. They
remain fine everywhere else.

### 3.2 Where to write things

| You're describing…                                  | Goes in                                                |
| --------------------------------------------------- | ------------------------------------------------------ |
| What aiball is, how to install/use it               | `README.md` (+ `docs/INSTALL.md`, `docs/WIN-INSTALL.md`) |
| Direction & planned work                            | `ROADMAP.md`                                           |
| User-facing changes between releases                | `CHANGELOG.md`                                         |
| How an agent should work on this codebase           | This doc (`docs/CONTRIBUTING.md`)                      |
| Operational surface (live runtime, restart, build)  | `CLAUDE.md`                                            |
| Subsystem deep-dive (loop, PTY, sandbox…)           | `docs/<TOPIC>.md`                                      |
| Decision rationale, alternatives considered         | The ticket thread                                      |
| WHY a piece of code is non-obvious                  | Code comment (one line) — see § 2.2                    |

When in doubt: ask whether a public user reading the doc cold needs
the information. If yes → reader-facing. If no → internal.

### 3.3 CHANGELOG flow

`CHANGELOG.md` follows the Keep-a-Changelog spirit, lightly. Two
sections matter:

- **`[Unreleased]`** — landed on `main` but not yet tagged. You add
  one bullet per user-visible change as you ship it.
- **`[X.Y.Z]` — YYYY-MM-DD** — the version cut. When you tag a
  release, the `[Unreleased]` bullets move under the new version
  header.

Skip the CHANGELOG entry when the change is purely internal (a
refactor with no behavior delta, a doc edit, a CI tweak). The reader
of CHANGELOG cares about *what changed for them*, not the audit
trail (the ticket thread + commit log handle that).

### 3.4 Versioning

The source of truth for the version is the `package.json` at the
repo root (the qcmp `aiball` component). It's surfaced via:

- `aiball --version` CLI
- `/api/health` JSON
- Footer of the web UI

Don't bump the version manually unless cutting a release. Releases
are the human's call; agents propose them via tickets when relevant
(e.g. accumulated `[Unreleased]` bullets warrant a tag).

### 3.5 Frontmatter & structure

No required YAML frontmatter for `docs/*.md` files. Conventions that
have emerged:

- Open with one paragraph stating what the doc is and who it's for.
- TOC (manual, `[label](#anchor)` list) is welcome above ~150 lines.
- Use `##` for top-level sections, `###` for sub-sections — `#` is
  the doc title.
- Code samples use triple-backtick fences with language tags
  (`yaml`, `ts`, `bash`, `powershell`).
- Tables for comparison or quick-ref material; bullets for narrative.

Match the surrounding docs' style when editing — don't introduce a
new flavor inside one file.

### 3.6 Link discipline

Cross-doc links use relative paths from the editing file:

- From `docs/CONTRIBUTING.md` → `MIGRATIONS.md` (sibling)
- From `docs/CONTRIBUTING.md` → `../README.md` or `../CLAUDE.md`
- From `README.md` → `docs/INSTALL.md`

Don't hardcode `https://github.com/…/blob/…` for cross-repo references
— relative paths survive forks and renames.

## 4. Agent kit

Claude agents have finite context. The "agent kit" is the discipline
of *what to preload vs what to look up vs what to remember across
sessions* so the context window stays usable.

### 4.1 Always preload

These are the docs an agent should have in context before starting
any non-trivial task on aiball:

1. **[`CLAUDE.md`](../CLAUDE.md)** (repo root) — operational truth
   for the live-runtime checkout (rebuild, hard restart for
   migrations, env vars). Loaded automatically by Claude Code.
2. **This doc** (`docs/CONTRIBUTING.md`) — the practical guide. If a
   convention conflicts with CLAUDE.md, this doc wins (CLAUDE.md is
   getting trimmed to operational ops over time).
3. **The engaged ticket's thread**, in `brief` mode. The pivot snapshot
   + the latest comment body is enough to resume; older bodies are
   captured in the snapshot by contract (§ 1.5).

That's it for the always-on layer. Everything else is lazy.

### 4.2 Lookup table: task type → which doc

When the task touches a subsystem, read the corresponding doc BEFORE
editing. Skim the headers first if the doc is large.

| Touching…                                      | Read first                                       |
| ---------------------------------------------- | ------------------------------------------------ |
| DB schema / queries / migrations               | [`docs/MIGRATIONS.md`](MIGRATIONS.md) + the relevant schema file |
| Config files / `.aiball.yaml` / per-project    | [`docs/CONFIGS.md`](CONFIGS.md) — the russian-doll layering |
| claude-loop, timer, wake logic                 | [`docs/CLAUDE-LOOP.md`](CLAUDE-LOOP.md)          |
| `windows/cl-pty-proxy/`                        | [`docs/PTY-PROXY-WINDOWS.md`](PTY-PROXY-WINDOWS.md) |
| Unix PTY proxy (`pty-proxy.py`)                | [`docs/PTY-PROXY.md`](PTY-PROXY.md)              |
| Tickets, comments, automation, lifecycle       | [`docs/TICKET_LIFECYCLE.md`](TICKET_LIFECYCLE.md) |
| Remote nodes / proxy mode / tailnet            | [`docs/REMOTE.md`](REMOTE.md) + [`docs/SECURITY.md`](SECURITY.md) |
| Tailscale specifics                            | [`docs/TAILSCALE.md`](TAILSCALE.md)              |
| Sandbox / autonomous agents                    | [`docs/SANDBOX.md`](SANDBOX.md)                  |
| Install paths, install modes                   | [`docs/INSTALL.md`](INSTALL.md) (Linux/macOS) or [`docs/WIN-INSTALL.md`](WIN-INSTALL.md) |
| MCP client / agent-facing tool surface         | [`MCP-CLIENT.md`](../MCP-CLIENT.md)              |
| Workflow (feature vs mainstream branch model)  | [`docs/WORKFLOW.md`](WORKFLOW.md)                |

When in doubt about which doc applies, grep first
(`grep -l <symbol> docs/`) rather than read everything.

### 4.3 Don't preload (read on demand)

- Source files. Don't pre-read `src/**/*.ts` unless the task targets
  them; use Grep / Glob to find the relevant module and Read only
  the relevant function.
- The full ticket thread on a long history. Use `ticket_get` with
  `brief: true` (default) for the resume snapshot + latest bodies;
  use `digest: true` for a bird's-eye scan of state progression
  across many comments; only use `full: true` with `limit` for a
  specific range.
- `node_modules/`, generated dist, lockfiles. Treat as opaque.
- Migration SQL files unless touching that migration. The journal
  (`drizzle/meta/_journal.json`) is the index.

### 4.4 Memory protocol

Claude Code maintains a persistent memory directory at
`~/.claude/projects/<project-slug>/memory/` with an `MEMORY.md`
index pointing to individual memory files. The contents survive
across sessions, so what you save shapes future-you's behavior.

**What to save:**

- **user** — the user's role, preferences, knowledge level,
  responsibilities. Helps tailor explanations and decisions.
- **feedback** — corrections and validated choices. Save the rule +
  the WHY (so future-you can apply it to edge cases). Save
  validations as well as corrections (so you don't drift away from
  approaches that worked).
- **project** — ephemeral state the user told you that isn't in the
  code (deadlines, who's blocking whom, the reason behind a refactor).
  Convert relative dates to absolute (`Thursday` → `2026-03-05`)
  before saving.
- **reference** — pointers to external systems (Linear projects,
  Slack channels, dashboard URLs).

**What NOT to save** (these can be derived from the live state):

- Code patterns, file paths, architecture. Read the code.
- Git history, who changed what. `git log` / `git blame` are
  authoritative.
- Debugging recipes ("how I fixed X"). The fix is in the code; the
  commit message has the WHY.
- Anything already documented in this repo.
- Ephemeral task state (in-progress work, current ticket details).
  Use TaskCreate / aiball ticket threads instead.

The exclusions apply even if the user explicitly asks to "remember"
something redundant — ask back what was *surprising* or *non-obvious*
about it; that's the kernel worth keeping.

**Before recommending from memory:**

A memory that names a file path, function, or flag is a claim that
it existed *when the memory was written*. It may have been renamed,
removed, or never merged. Before acting on such a memory:

- If the memory names a file: check the file exists.
- If the memory names a function or flag: grep for it.
- If the user is about to act on your recommendation: verify first.

"The memory says X exists" is not the same as "X exists now."

### 4.5 Cross-platform awareness

aiball runs on Linux, macOS, and Windows. A few load-bearing
specifics:

- **Mux command**: `tmux` on Linux/macOS, `psmux` on Windows
  (compiled fork). Use `MUX_CMD` from `src/claude-loop/state.ts`
  rather than hardcoding.
- **Proxy node mode**: some hosts (e.g. graphite on Windows) run as
  a proxy relaying to a central daemon over Tailscale. Local DB is
  bypassed; everything flows to the upstream. See
  [`docs/REMOTE.md`](REMOTE.md) and the proxy-node architecture
  in [`docs/SECURITY.md`](SECURITY.md).
- **ConPTY vs Unix PTY**: Windows uses the ConPTY proxy
  (`cl-pty-proxy`, Rust), Linux uses the Python PTY proxy. They
  expose the same interface — write the calling code platform-agnostic
  and let the launcher pick.

When a behavior is platform-specific, say so explicitly in the
ticket / commit / comment. "Works on Linux" is not the same as
"ships" until Windows is verified too.

---

*This doc is a living guide — flag drift via a ticket; don't let two
sources of truth diverge silently.*

[#319]: # "feature intent — branch + PR isolated work"
