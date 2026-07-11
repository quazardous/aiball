# Claude Code hooks in aiball

`claude-loop` drives a Claude Code session by installing **session-scoped
hooks** (registered in `src/claude-loop/cli.ts`, transported to the timer over
`loop.sock` by `hook-emit.ts`, consumed in `hook-watcher.ts`). This document is
the single reference for **which hook events aiball wires, which it deliberately
does not, and why**.

Official event roster: <https://code.claude.com/docs/en/hooks.md>.

## Principles

- **Prefer a deterministic hook signal over scraping the tmux pane.** Much of
  the runtime state today is inferred by matching footer text (busy, compaction,
  API-retry, login). That inference is fuzzy and a recurring source of
  cross-firing between the loop and the human. A hook that reports the same fact
  deterministically is the preferred source; the pane watcher then becomes a
  fallback, and is removed once the hook has proven itself.
- **One injection path.** aiball injects the next prompt through the **PTY proxy
  (side-load)**. We deliberately do **not** also inject via a hook's
  `additionalContext`. Surfacing the next wake through the Stop hook is not
  critical, and a second injection path multiplies the states to reason about —
  it is a bug source, not a convenience. Keep a single source of truth.
- **Gate native interactivity on human presence.** When a native prompt would
  block an autonomous loop (no human to answer), a hook denies it and redirects
  the agent ("no one to approve — move on / do X"), fail-open when unsure. See
  `hook-verdict.ts`.
- **A hook cannot see live keystrokes or an ESC interrupt.** No documented event
  reports frame-by-frame human typing or a mid-turn interrupt, so the PTY proxy
  stays necessary for live-presence detection. Hooks tighten the runtime layer;
  they do not replace it.

## Roster

Status legend — **Used**: an aiball hook is wired to it today. **Candidate**: not
wired, but there is a concrete pane-scrape / bespoke detector it would replace.
**Not used**: no current usage and no concrete thing in aiball it would replace.

| Event | Status | Why (or why not) |
|---|---|---|
| SessionStart | **Used** | Essentially a **weak end-of-boot signal**: it is *one* input that can seal the boot machine (`boot-machine.ts` `HOOK_SEAL`), not the authority — boot also seals on a deadline / pane-decay (`DEADLINE_REACHED`) when the hook is missed. Emitted slim (`session-start-hook.ts`), same path for resume/clear. Note: the `compact` source is handled but its matcher is **not registered** — a known gap. |
| Stop | **Used** | The turn-end "ping or sleep" hook (`stop-hook.ts`): per-turn token capture, error backoff, and the wake-injection decision. We do **not** extend it to inject the next prompt via `additionalContext` (see *One injection path*). |
| UserPromptSubmit | **Used** | Emits a turn-start timestamp (`user-prompt-submit-hook.ts`). The human-vs-injected-ping distinction is derived timer-side by time-correlation today; a deterministic distinction by payload content is the main candidate improvement. |
| PreToolUse | **Used** | Gates the `AskUserQuestion` tool: when no human is present, deny + redirect the agent to the ticket thread (`hook-verdict.ts`), fail-open. Candidate to generalize to permission walls. |
| StopFailure | **Candidate** | Turn ended on an API error. Would replace the error-banner scraping (`error-backoff.ts`, consumed in `stop-hook.ts`) so the loop never wakes into a dead-API turn. |
| Notification | **Candidate** | Claude's own notifications (auth / needs-input / permission). Would replace the login and API-unreachable banner watchers (`pane-watchers/runtime-watchers.ts`) and give a reliable "Claude is actually waiting" to sharpen busy/idle. |
| PreCompact / PostCompact | **Candidate** | Deterministic start/end boundaries of compaction. Would remove the entire `compacting-detector.ts` pane-scrape and its grace timer. |
| SessionEnd | **Candidate** | Deterministic teardown of `loop.sock` + state on a clean exit. Complements — does not replace — the crash/orphan detection in `cmds/health.ts` and `parent-liveness.ts` (a hard kill fires no SessionEnd). |
| PermissionRequest / PermissionDenied | **Candidate** | Surface the permission wall: with an empty `permission_mode`, an autonomous loop stalls silently on the first permission prompt today, with no detector. `PermissionDenied` can return `retry: true`. |
| PostToolUse | **Candidate** | Per-tool token capture (today done indirectly by the MCP server writing an `active-ticket` marker, `token-capture.ts`); also a signal for when the agent writes to its own board. |
| FileChanged / ConfigChange | **Candidate** | `FileChanged` (paths declared via `SessionStart` `watchPaths`) would replace the bespoke `fs.watch` on `.aiball.yaml` (`src/proxy.ts` `startConfigWatch`). `ConfigChange` covers Claude's own `settings.json`. |
| CwdChanged | **Candidate (low)** | Re-validate MCP/socket/project paths on a directory change. A loop is one fixed project today, so this is rare. |
| WorktreeCreate / WorktreeRemove | **Candidate (low)** | Native worktree lifecycle. Worktrees are created only by the sandbox CLI today (`src/sandbox/cli.ts`), not by the `feature` loop flow. |
| PostToolUseFailure, PostToolBatch, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, TeammateIdle, MessageDisplay, InstructionsLoaded, UserPromptExpansion, Elicitation, ElicitationResult | **Not used** | No existing usage and no concrete pane-scrape / state in aiball they would replace. Listed so their absence reads as deliberate, not an oversight. Revisit if a real anchor appears. |

## Where hooks are wired

- **Registration** — `src/claude-loop/cli.ts` builds the `settings.hooks` JSON
  passed to the claude spawn (one entry per used event, with matchers).
- **Handlers** — one file per used hook today
  (`session-start-hook.ts`, `stop-hook.ts`, `user-prompt-submit-hook.ts`,
  `pretooluse-hook.ts`). A declarative registry to collapse these insertion
  points into a single source is proposed separately.
- **Transport** — `hook-emit.ts` (`emitHookEventToTimer` → `loop.sock`, with an
  offload buffer when the socket is absent).
- **Consumer** — `hook-watcher.ts` types the inbound events;
  `proxy-event-dispatcher.ts` correlates them (e.g. auto-wake vs human prompt).
