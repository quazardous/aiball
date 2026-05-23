# aiball configuration — the layered ("russian-doll") model

aiball reads configuration from several layers that stack, lowest →
highest precedence. Each *concern* (identity, autopoll, loop timeouts,
prompts, formatting, tags) layers slightly differently — this page is the
map. For the per-key annotations, the canonical reference is the
commented template [`.aiball.yaml.example`](../.aiball.yaml.example).

## The files (where config lives)

| File | Scope | Carries |
| --- | --- | --- |
| `config/defaults/claude-loop-pings.yaml` | shipped (in the install) | wake phrases (`ping_messages`), wake-CTA templates (`prompts:`/`wake_phrases:`), linkifier patterns (`formatting:`) |
| `config/defaults/tags.yaml` | shipped | the read-only base tag catalog |
| `~/.config/aiball/config.yaml` | global, per-user (honours `XDG_CONFIG_HOME`) | `prompts:`, `formatting:`, `tags:`, `providers:` — settings you want identical across every project / host-level |
| `.aiball.yaml` | per-project (walks up from cwd, like git) | `autopoll:`, `consumer:`, `claude_loop:`, `workflow:`, `prompts:`, `formatting:`, `tags:` |
| `.mcp.json` → `mcpServers.aiball.env` | per-project | **DEPRECATED** identity fallback (`AIBALL_AGENT`/`AIBALL_PROJECT`) |
| env vars | process | `AIBALL_AGENT`/`AIBALL_PROJECT` (identity override), `AIBALL_URL`/`AIBALL_SOCK`/`AIBALL_HOME`/`AIBALL_HUMAN`, `CL_*` (claude-loop children), `XDG_CONFIG_HOME` |
| CLI flags | invocation | `claude-loop --interval`/`--user-grace`, `aiball autopoll …` |

`.aiball.yaml` is **per-project and optional**: drop an empty `{}` to turn
autopoll on with defaults; without the file, autopoll stays silent. The
loader (`src/autopoll/config.ts:loadConfig`) walks up from cwd to find it.
Inspect what resolved (and from which layer) with **`aiball check`**.

## Precedence per concern

Different blocks merge differently — that's the "russian doll" part.

### Identity — `consumer:` (agent + project) — *replace, highest non-null wins*
1. `AIBALL_AGENT` / `AIBALL_PROJECT` env — priority override (special cases only)
2. `.aiball.yaml` `consumer:` — **canonical, recommended**
3. `.mcp.json` `mcpServers.aiball.env` — DEPRECATED (works, but `aiball check` + claude-loop warn)
4. Defaults — `project = basename(cwd)`, `agent = <project>-claude`

(autopoll applies no default — a null agent means "stay silent".)

### Autopoll — `autopoll:` — *per-project only*
Read from `.aiball.yaml` (defaults when the file/block is absent). Pilot
from the CLI: `aiball autopoll enable|disable|tone <t>|throttle <n>`.
Keys: `enabled`, `volatile`, `throttle_seconds`, `include_recent_tickets`,
`backlog`, `tone` (`hint`|`directive`|`imperative`).

### claude-loop timeouts — `claude_loop:` — *defaults → yaml → CLI/env*
Code defaults → `.aiball.yaml` `claude_loop:` → CLI flags (`--interval`,
`--user-grace`) and `CL_*` env (which the timer/hook child processes read).
Keys: `interval_seconds`, `boot_grace_seconds`, `user_grace_seconds`,
`wake_in_flight_ttl_ms`, `esc_takeover`, `ask_grace_seconds`, `afk_key`,
`afk_window_ms`. See [`CLAUDE-LOOP.md`](./CLAUDE-LOOP.md).

**AskUserQuestion gate + AFK (#351).** In a loop, `AskUserQuestion` is allowed
only if a human acted within `ask_grace_seconds` (default 600 = 10 min, longer
than the wake user-grace — a stalled question is cheap vs a lost one); past
that it redirects the agent to ask via a ticket comment. `afk_key` lets you
flag yourself away *immediately* (no waiting for the timeout): the PTY proxy
watches stdin for the combo and, on match, **toggles** an `afk` marker the gate
honours (#381 — the combo flips away↔back, robust to the two keystrokes
arriving coalesced in one read); resuming any **typing** also clears it. `afk_key` uses VS Code
notation — `+` joins modifiers, a space is a 2-combo sequence (default
`"esc esc"`); `afk_window_ms` (default 400) bounds the gap between the two
combos. Since the proxy only sees the terminal's **byte stream**, the
supported subset is what maps to distinct bytes (`esc`, `ctrl+<char>`,
f-keys, literals); `shift`/`alt+shift`/`ctrl+shift` aren't distinguishable
without the kitty/win32 keyboard protocol.

### Workflow hints — `workflow:` — *defaults → yaml*
`hint_branch`, `hint_worktree` (both off by default). See
[`WORKFLOW.md`](./WORKFLOW.md).

### Wake-CTA / prompt templates — `prompts:` — *3 layers, slot-grain replace*
`config/defaults/claude-loop-pings.yaml` → `~/.config/aiball/config.yaml`
→ `.aiball.yaml`. Project wins over global wins over defaults; each *slot*
is replaced wholesale (no deep merge inside a slot, so you can switch
between the string / list / `{tone: list}` shapes freely). Full slot
reference + placeholders + pluralization rules are in `.aiball.yaml.example`.

### Linkifier — `formatting:` — *3 layers, merge by `id`*
Same file chain as `prompts:`. Shipped defaults are non-removable (always
run as fallback); a `.aiball.yaml`/global entry either **overrides** a
default by reusing its `id` or **adds** a new pattern with a fresh `id`.
Regex is validated at load; invalid entries are dropped (logged to stderr).
Served to the frontend at boot via `GET /api/config`.

### Tags — `tags:` — *3 layers, COMPOSITE (additive)*
`config/defaults/tags.yaml` → global → `.aiball.yaml`. Unlike
prompts/formatting, every layer **adds**. Config tags render read-only
(lock badge) in the Tags panel. The global file can declare tags per
project via a `tags: { global: [...], projects: { name: [...] } }` map;
a bare list in `.aiball.yaml` means "tags for this project".

### Remote-access providers — `providers:` — *global only (host-level, #354)*
Remote access exposes the whole machine's daemon, so this block lives in the
**global** config only (`~/.config/aiball/config.yaml`), not per-project.
v1 implements **tailscale** and **autostart only** (bring up at daemon
start; supervision/re-up is a follow-up). The systemd unit's
`ExecStartPost` runs `aiball providers up`, so an enabled+autostart provider
comes up whenever the daemon (re)starts. No-op when the block is absent.

```yaml
# ~/.config/aiball/config.yaml
providers:
  tailscale:
    enabled: true       # default true when the block is present
    autostart: true     # bring up with the daemon (ExecStartPost). default true
    mode: https         # https (default) | http  → aiball-tailscale up [--http]
    # port: 8443        # optional listen port override → --port
  # cloudflared: { … }  # future, same shape
```

Manage from the CLI: `aiball providers status | up [--all] | down`. A present
provider block defaults `enabled`/`autostart` to true (declaring it = wanting
it). The bring-up reuses `bin/aiball-tailscale` (see [`TAILSCALE.md`](./TAILSCALE.md)).

> Activation note: the `ExecStartPost` lives in the shipped unit
> (`systemd/aiball.service`). An existing install picks it up after a re-run
> of `install.sh` (regenerates the unit + `daemon-reload`); then a daemon
> (re)start brings the provider up.

## State / data dirs (not config, but related)

| Path | What |
| --- | --- |
| `~/.local/share/aiball/` | SQLite DB, UDS socket, uploads, spool |
| `~/.cache/aiball/` | autopoll watermarks (`autopoll-<agent>.json`) |
| `~/.claude-loop/<name>/` | per-loop runtime state (see [`CLAUDE-LOOP.md`](./CLAUDE-LOOP.md)) |

## See also

- [`.aiball.yaml.example`](../.aiball.yaml.example) — the canonical annotated template (per-key detail).
- [`CLAUDE-LOOP.md`](./CLAUDE-LOOP.md) — the `claude_loop:` block in context.
- [`MIGRATIONS.md`](./MIGRATIONS.md) — DB schema (a different kind of "config").
