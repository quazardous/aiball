# Sandbox loop

> **Status: experimental / partial.** See [`ROADMAP.md`](../ROADMAP.md#sandbox-loop)
> for what's missing. For daily-driver autonomous wrapping use
> [`claude-loop`](../README.md#quickstart--claude-loop-recommended).
> This page stays for the experimentation surface; caveat emptor.

Run a Claude Code session autonomously against a fixed plate of aiball
tickets. The session lives in a tmux window, observes its plate via hooks,
and exits when there's nothing actionable left (or when you tell it to
halt). This doc covers how it's wired, the three gestures the agent inside
the sandbox is expected to perform, and the common ways things go sideways.

## Pre-requisites

| | |
| --- | --- |
| **tmux** | Required. The sandbox is a tmux session; without it nothing spawns. |
| **jq** | Used by the hooks for plate manipulation. Most distros have it; if not `dnf install jq` / `apt install jq`. |
| **claude-code** | The CLI for the spawned session. Needs `--permission-mode auto` (Max / Team / Enterprise / API plans — *not* Pro, which doesn't enable that flag). |
| **aiball daemon** | Running locally. `aiball status` confirms. |
| **AIBALL_PROJECT** | Either exported in your shell, set in `.aiball.yaml`, or inferrable from the first ticket id (auto-resolved at launch). |

## First launch

```bash
aiball sandbox start --tickets "42,43" --name release-2.6
```

What this does:

1. Creates `~/.aiball-sandbox/release-2.6/` with:
   - `plate.json` — the tickets the agent is expected to work on
   - `env` — sourceable shell file (`AIBALL_AGENT`, `AIBALL_PROJECT`, `SB_*` flags, and the forwarded `AIBALL_SOCK` / `AIBALL_TOKEN` so the hooks reach the daemon)
   - `hooks/session-start.sh` + `hooks/stop.sh` — thin bash wrappers that exec the TS hook entrypoints in `src/sandbox/`
2. Pre-registers the agent consumer (`claude-release-2.6`) with `kind=sandbox` so the Consumers panel can distinguish loop agents from interactive ones.
3. Builds an inline Claude Code settings JSON that wires the hooks and pre-approves the aiball MCP tools (so the auto-mode classifier doesn't block `ticket_close` / `ticket_reply`).
4. Spawns `tmux new-session -d -s sb-release-2.6 -c <dir> bash -lc 'source env; exec claude --settings <inline-json> --permission-mode auto'`.
5. Schedules an initial "Start processing your ticket plate." nudge so claude actually starts (SessionStart context alone doesn't trigger a turn).

Useful flags:

- `--name <name>` — pick a stable name (default: random short hex). Same name = same state dir, so re-running `start` with the same name conflicts.
- `--worktree` — create `~/sandboxes/<name>/` as a git worktree (see §Worktree).
- `--base <ref>` — base for the worktree (default `HEAD`).
- `--attach` — drop you into the tmux session right after spawn (otherwise the wrapper exits silently and you reach the session via `aiball sandbox attach`).
- `--permission-mode <mode>` — `auto` (default), `bypassPermissions`, `dontAsk`. Modes that prompt (`default`, `acceptEdits`, `plan`) will *stall* the loop because there's no human at the keyboard.

## The three gestures

The agent inside the sandbox is expected to close, escalate, or halt — nothing else. The SessionStart hook explains these in the brief it injects, so the agent should follow them naturally; this is the reference for what the convention means.

### 1. Close (done with this ticket)

```
ticket_close({ ticket_id: 42 })
```

If the agent is the original reporter, this auto-approves with owner-bypass. Otherwise the close goes through moderation. The Stop hook detects the close on its next tick (it queries aiball for each plate entry) and stops considering it actionable.

### 2. Escalate (stuck on this one, human take over)

```
ticket_reply({
  target_id: 42,
  body: "Blocked on X. The repo doesn't have Y, can't proceed without it.",
  then: "resolved"
})
```

The `then: "resolved"` chain marks the ticket as agent-resolved. The autopoll backlog count and the Stop hook stop treating it as actionable — it's in the human's court now. The reporter (you) sees the resolution proposal in the UI, reads the blocker, and either:
- accepts (closes the ticket — agent was right, work isn't possible)
- rejects + replies with the missing info (reopens for the agent to retry)

### 3. Halt (the whole plate is stuck)

```bash
jq '.halt = true' "$SB_STATE_DIR/plate.json" | sponge "$SB_STATE_DIR/plate.json"
```

(Use `sponge` from moreutils, or `> tmp && mv tmp`.) On the next Stop tick the hook releases unconditionally and claude exits. The tmux session dies. The state dir remains for post-mortem.

## Observation

```bash
aiball sandbox list                    # who's running, last block, plate summary
aiball sandbox tail <name> --lines 40  # last N lines of the pane (non-blocking)
aiball sandbox attach <name>           # tmux attach
```

Loop sandboxes attach **read-only by default** (your keystrokes don't reach the session, so you can't accidentally derail it). Plain sandboxes (created via `aiball sandbox plain` for mux testing) attach writable. Override with `--write` or `--read-only` on the attach command.

## Life after exit

The state dir stays on disk after the sandbox exits — useful for post-mortem (last plate state, last-block.json, hook logs). The watcher cron in the aiball daemon (`src/sandbox/watcher.ts`) polls every 30s and, when it sees a state dir for a dead tmux session AND new unread pings for that agent, re-spawns the tmux session via `aiball sandbox respawn`. The SessionStart hook re-injects the brief with the latest plate. So a sandbox that escalated and exited automatically resumes when you reply.

Cleanup:

```bash
aiball sandbox rm <name>     # kill tmux + remove state dir (force with --force if dirty)
aiball sandbox prune         # finds orphan state dirs (no tmux session) and offers to delete
```

## Worktree mode

Pass `--worktree` to spawn the sandbox in `~/sandboxes/<name>/` (a fresh `git worktree add` off `--base` or `HEAD`). The branch created is `sandbox/<name>`. Useful for parallelism (two sandboxes editing the same repo without conflict) and for keeping your main checkout clean.

The loop is **identical** between in-place and worktree modes — only the `cwd` passed to tmux changes. Hooks, plate, env, MCP wiring all behave the same.

Tear-down: `aiball sandbox rm <name>` runs `git worktree remove <dir>` for worktree sandboxes (and `--force` if there are uncommitted changes).

## MCP hardening

Sandbox sessions boot the aiball MCP server with `AIBALL_MCP_MODE=sandbox` exported. In that mode:

- The `by_agent` parameter is **dropped from the schemas** of every tool that accepts it (`ticket_new`, `ticket_reply`, `ticket_close`, `ticket_update`, `ticket_decide`, …).
- The server always forces `by_agent = $AIBALL_AGENT` regardless of what the agent passes.

This stops a sandbox from impersonating another agent (e.g. posting `by_agent: "human"` to bypass moderation). Mode-off (interactive Claude Code sessions) behaves identically to before — `by_agent` stays optional.

## Troubleshooting

**Hook silent ("nothing happens after Claude responds")**

Most common cause: the hook can't reach the daemon. Check the env file:

```bash
cat ~/.aiball-sandbox/<name>/env | grep -E 'AIBALL_(SOCK|TOKEN|URL)'
```

`AIBALL_SOCK` should point at `~/.local/share/aiball/sock` (or `AIBALL_TOKEN` should be set if you're somehow on TCP). If both are missing, the hook can't auth. Fixed via the wrapper at install time — re-run `./install.sh --symlink` if you suspect a stale shim.

**Claude hesitates ("Should I check the pings?")**

That's a documented failure mode. The convention says: drain pings yourself, react, don't ask. If the sandbox keeps doing this, the brief in the SessionStart hook should be more aggressive. Check `skill/hooks/sandbox-session-start.sh` for the wording.

**Anti-oscillation**

If Claude refuses to act on a ticket but keeps stopping, the Stop hook would normally block forever. Anti-oscillation: the hook stores `(plate_fingerprint, blocked_ticket_id)` in `~/.aiball-sandbox/<name>/last-block.json`. On the next call, same fingerprint + same blocked ticket → release (let claude exit). Prevents a tight loop.

**Classifier blocks a tool call**

`--permission-mode auto` uses a classifier. The aiball MCP tools are pre-approved via the inline settings (`permissions.allow`). If you see "permission denied" for `ticket_close` or similar, check `AIBALL_MCP_ALLOWLIST` in `src/sandbox/cli.ts` — that's the canonical list. For bash commands the sandbox should also be able to run, narrow allow rules (e.g. `Bash(npm:*)`) survive auto mode; broad `Bash(*)` does not.

**Sandbox exited, can't tell why**

Check the pane buffer before the session dies:

```bash
aiball sandbox tail <name> --lines 200
```

Common exits: `/exit` typed accidentally, plate halted, all tickets closed, classifier blocked a needed tool with no fallback. The state dir is preserved so you can inspect `last-block.json` and `plate.json`.

## Known limits (assumed in v1)

- **Not stress-tested in multi-hour autonomous sessions.** The smoke tests cover trivial tickets only. The watcher → respawn flow works in synthetic conditions but hasn't been run for a 4h+ task with escalations and reopens. See the roadmap (solidify aiball) — this is one of the listed dettes.
- **No parallelism limit.** `aiball sandbox start` will happily spawn 50 sandboxes against the same project; each eats a Claude session and worktree disk. There's no hard cap or soft warn yet.
- **Docs assume Linux + bash.** macOS should work (tmux, jq, claude-code are portable) but isn't routinely tested. Windows via WSL only.
- **No retry budget.** If a tool call fails (network, classifier, etc.) the agent has to handle it in-prompt. Aiball doesn't track tool failures or impose a max-retries per ticket.

## See also

- `MCP-CLIENT.md` — the agent-facing convention guide. Section 4 ("Be proactive — don't ask permission to drain") is the directly relevant subsection.
- `README.md` — the "When does aiball pay back?" section frames why the sandbox is the autonomous half of the bet.
- `src/sandbox/cli.ts` — entry points for all the `aiball sandbox …` subcommands.
- `src/sandbox/hook-session-start.ts` — the brief injected at boot.
- `src/sandbox/hook-stop.ts` — the release/block decision logic.
- `src/sandbox/watcher.ts` — the daemon cron that respawns dead sandboxes on new pings.
