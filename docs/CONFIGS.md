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
| CLI flags | invocation | `claude-loop --interval`/`--check-cmd`/`--wait`, `aiball autopoll …` |

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
Keys: `enabled`, `volatile`, `throttle` (a duration, see below; `0` = at every
Stop), `recent_tickets` (at most 20), `backlog`, `tone`
(`hint`|`directive`|`imperative`).

### claude-loop timeouts — `claude_loop:` — *defaults → yaml → CLI/env*
Code defaults → `.aiball.yaml` `claude_loop:` → CLI flags (`--interval`,
`--check-cmd`, `--wait`/`--no-wait`) and `CL_*` env (which the loop's
child processes read). Keys: `interval_seconds`, `wake_tempo_seconds`,
`boot_grace_seconds`, `boot_min_seconds`, `presence_hold_seconds` (durations:
`1m`, `90s`, or a bare number of seconds),
`wake_in_flight_ttl_ms`, `input_hot_ttl_ms`, `pane_probe_fast_ms`,
`pane_probe_slow_ms`, `esc_takeover`, `mouse`, `bar`, `session`, `afk_key`, `afk_window_ms`, `wait`,
`drained_strategy`, `log_level`, `permission_mode`, `gates`. See
[`CLAUDE-LOOP.md`](./CLAUDE-LOOP.md).

`mouse` (`on` | `off`) is also read from the **global** config, since it is
a per-user taste rather than a project's: defaults → global → project →
`start --mouse`. So are `bar` (`tmux` | `external`, `start --bar`) and
`session` (`host` | `tmux`: where Claude runs, `host` by default — `tmux` on
Windows for now, where the session host does not run yet;
`start --host` / `--tmux`, and a `restart` keeps a loop where it runs).

**AskUserQuestion gate + AFK.** In a loop, `AskUserQuestion` is allowed
while the **presence hold** is live (typing arms a hold of
`presence_hold_seconds`, default 10 min; F9 cycles away → hold →
present-∞); past that it redirects the
agent to ask via a ticket comment — a stalled question is cheap vs a
lost one. `afk_key` (default `f9`) is the immediate control: the PTY
proxy watches stdin for the key and cycles the presence state on match;
`afk_window_ms` (default 400) is a post-fire key-repeat debounce.
`afk_key` uses VS Code notation (`+` joins modifiers). Since the proxy
only sees the terminal's **byte stream**, the supported subset is what
maps to distinct bytes (`esc`, `ctrl+<char>`, f-keys, literals);
`shift`/`alt+shift`/`ctrl+shift` aren't distinguishable without the
kitty/win32 keyboard protocol.

### Bar colour profile — `colors:` — *defaults → global → yaml*
The claude-loop tmux status-bar colours. Code defaults →
`~/.config/aiball/config.yaml` `colors:` (machine-wide theme) →
`.aiball.yaml` `colors:` (project wins). Each key is a raw tmux colour token
(`colour16`, `red`, `#0087ff`); an omitted key keeps the layer below. The bar
text has **two** foregrounds because it sits on two backgrounds: `island_fg`
(light, `claude-…` on the black island) and `bar_fg` (the state-coloured region
`name [state] · afk:key` — black by default so it reads on the busy electric-blue
/ boot-yellow bar). Keys: `island_fg`, `bar_fg`, `afk_label_fg`, `busy_bg`,
`idle_bg`, `boot_bg`. Full annotated block in `.aiball.yaml.example`.

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

### Remote-access providers — `providers:` — *global only (host-level)*
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
    mode: https         # https (default) | http
    # port: 8443        # optional listen port override (default 443/80)
  # cloudflared: { … }  # future, same shape
```

Set it up with `aiball init tailscale [--http] [--port N]`; manage from the CLI:
`aiball providers status | up [--all] | down`. A present provider block defaults
`enabled`/`autostart` to true (declaring it = wanting it). The bring-up calls
`tailscale serve` directly (inlined in `src/providers.ts`; see
[`TAILSCALE.md`](./TAILSCALE.md)).

> Activation note: the `ExecStartPost` lives in the shipped unit
> (`systemd/aiball.service`). An existing install picks it up after a re-run
> of `install.sh` (regenerates the unit + `daemon-reload`); then a daemon
> (re)start brings the provider up.

### Host-level timings and upstream — *global only*
In the global config, read through the schema like the settings the UI shows
(typed, ranged; a value outside its range falls back to the default):
`assign_window_sec` (a duration, default 4h: how long an assignment or claim
stays live), `hot_window_sec` (a duration, default 20m: how recent a move keeps
a ticket hot), `upstream_transport` (`auto`|`http`|`gh`), `upstream_sync`
(`pull`|`off`). `upstream_auth.<provider>.token` is a secret: read from the
same file, never shown in the UI.

### Serving under a path — `server.base_path` — *global only (host-level)*
To serve aiball under a path (`https://host/aiball/`) behind a reverse proxy
that forwards the path as it is (nginx, traefik without a strip middleware),
declare it in the **global** config:

```yaml
# ~/.config/aiball/config.yaml
server:
  base_path: /aiball
```

The daemon removes the path from each request before its routes and the bus
see it; a request without it is served as before, so a proxy that strips the
path works with the same setting. Unset, it takes the tailscale provider's
`path` (tailscale strips it, so nothing changes there); neither = served at
the root. Read at daemon start: `aiball restart` to apply a change. The web UI
and a proxy node's `url` (`https://host/aiball`) need nothing more.

## Durations and renamed keys

A setting that is a time is a **duration**: seconds on the wire (`config.managed`
gives its value, default and range in seconds), written by a person in a
notation: `d h m s`, in that order, each unit at most once, spaces allowed
between parts — `90s`, `15m`, `1h30m`, `1h 30m`, `2d`. A bare integer is
seconds, `0` is zero. `config.set` takes either; a file takes either. A client
that shows one writes it back largest units first (`5400` → `1h30m`); the
grammar is the one in `src/config/duration.ts`, to reproduce as is.

The managed keys are dotted paths without a unit suffix; a setting's section
is its key less the last segment (`tickets.wait_credit.earn.resolved` →
`tickets.wait_credit.earn`). The keys renamed to this shape still work under
their old name for one version — a file's value converted from the old unit,
`config.set` answering `renamed_from` — and claude-loop warns about a file
that still spells one the old way:

| Old key | New key |
| --- | --- |
| `tickets.default_priority` | `tickets.defaults.priority` |
| `tickets.auto_broadcast_new` | `tickets.defaults.broadcast_new` |
| `tickets.summary_until_max` | `tickets.rules.summary_max` |
| `tickets.require_then` | `tickets.rules.require_then` |
| `tickets.require_commits` | `tickets.rules.require_commits` |
| `tickets.step_stale_hours` | `tickets.steps.stale` |
| `tickets.step_hot_minutes` | `tickets.steps.hot` |
| `tickets.step_after_max_minutes` | `tickets.steps.max_wait` |
| `tickets.wait_credit_enabled` | `tickets.wait_credit.enabled` |
| `tickets.wait_credit_refund` | `tickets.wait_credit.refund` |
| `tickets.wait_credit_start_minutes` | `tickets.wait_credit.start` |
| `tickets.wait_credit_max_minutes` | `tickets.wait_credit.max` |
| `tickets.step_min_wait_minutes` | `tickets.wait_credit.floor` |
| `tickets.wait_credit_resolved_minutes` | `tickets.wait_credit.earn.resolved` |
| `tickets.wait_credit_resolved_no_commit_minutes` | `tickets.wait_credit.earn.resolved_no_commit` |
| `tickets.wait_credit_wontfix_minutes` | `tickets.wait_credit.earn.wontfix` |
| `tickets.wait_credit_commit_max_age_hours` | `tickets.wait_credit.earn.commit_max_age` |
| `tickets.wait_credit_max_commits_per_comment` | `tickets.wait_credit.earn.commits_per_comment` |
| `tickets.wait_credit_commit_lines_per_minute` | `tickets.wait_credit.earn.lines_per_minute` |
| `tickets.wait_credit_commit_max_minutes` | `tickets.wait_credit.earn.commit_max` |
| `tickets.wait_credit_commit_min_minutes` | `tickets.wait_credit.earn.commit_min` |
| `tickets.claim_protect_minutes` | `tickets.backlog.claim_protect` |
| `tickets.blocked_cooldown_multiplier` | `tickets.backlog.blocked_multiplier` |
| `tickets.sink_then_continue_minutes` | `tickets.backlog.after_step` |
| `autopoll.throttle_seconds` | `autopoll.throttle` |
| `autopoll.include_recent_tickets` | `autopoll.recent_tickets` |

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
