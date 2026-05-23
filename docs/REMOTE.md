# Remote aiball — a local `claude-loop` slaved to a remote daemon (#390)

Run a `claude-loop` **on machine B** while the aiball daemon lives **on machine
A** (reachable over a tailnet or LAN). Machine B needs **no aiball install of its
own** — only the `claude-loop` checkout. The loop, its tmux session, the PTY
proxy, human-typing detection and all state files stay **local on B**; only the
**data plane** (tickets, comments, pings, uploads) travels to A over HTTP+token.

```
   machine B (project lives here)          machine A (the daemon)
   ┌─────────────────────────────┐         ┌────────────────────────┐
   │ claude-loop  → claude (tmux) │         │  aiball daemon         │
   │ timer, PTY proxy, state ─────┼──HTTP──▶│  SQLite, /api, /uploads │
   │ AIBALL_URL/TOKEN, SOCK empty │  token  │  (tailscale / LAN)     │
   └─────────────────────────────┘         └────────────────────────┘
```

This is **not** "run the loop on the remote host". The loop runs where claude +
tmux run (B); A is just the shared board.

## Two ways to wire B → A

- **Direct (#390)** — each `claude-loop` on B points at A with `--aiball-url` /
  `--aiball-token` (see [Setup](#setup) below). Per-loop config.
- **Proxy mode (#394, recommended for a busy host)** — run a **local aiball
  daemon on B in proxy mode**; it transparently relays to A. Then **every** local
  client (loops, MCP, CLI, web UI) just uses localhost / the UDS as usual
  (token-less, SSE included) — no per-client remote config. See
  [Proxy mode](#proxy-mode) below. The two coexist; pick whichever fits.

## Proxy mode

On B, add a `proxy:` block to the **global** config (`~/.config/aiball/config.yaml`)
and run the daemon normally:

```yaml
proxy:
  url: https://<A-host>:7777
  token: aiball-<48 hex>      # mint on A: aiball auth issue --consumer <id>
```

The B daemon becomes a **transparent relay**: it forwards `/api/*` and
`/uploads/*` to A (injecting the bearer), pipes A's SSE (`/api/events`) back to
local subscribers, and keeps no local DB. Local clients on B talk to the UDS /
`127.0.0.1` token-less, exactly as if A were local. If A is unreachable the proxy
answers 502 and the local client spools the write for replay (#389).

> Today the proxy relays the data plane; **launching a loop on B from A's web UI**
> (#393) needs a reverse control channel (A→B) and is a follow-up — local launch
> on B works now.

## Setup

### 1. On A — mint a token for the loop's consumer

The token is bound to a **consumer** (the loop's identity). `aiball auth issue`
**creates the consumer on the fly** if it doesn't exist yet, so this is one step:

```bash
# on machine A
aiball auth issue --consumer my-remote-agent
#  → Created consumer 'my-remote-agent' (agent).
#    Token issued for my-remote-agent:
#       aiball-<48 hex>
```

> The daemon authenticates an agent by **the token's** consumer — the
> `--consumer` flag on B must name the **same** consumer the token is bound to
> (a mismatch is ignored for agent tokens; the token wins).

Make sure the daemon is reachable from B. Over Tailscale, see
[`TAILSCALE.md`](./TAILSCALE.md) (`tailscale serve`); over a LAN, bind/forward
the daemon's port (default `7777`).

### 2. On B — start the loop pointed at A

```bash
# on machine B, in the project dir
claude-loop start \
  --aiball-url   http://<A-host>:7777 \
  --aiball-token aiball-<48 hex> \
  --consumer     my-remote-agent \
  --project      my-project
```

What the flags do:

| Flag | Effect |
|------|--------|
| `--aiball-url`   | Target the remote daemon over HTTP (**required** for remote mode). |
| `--aiball-token` | Bearer token from step 1 (**required** with `--aiball-url`). |
| `--consumer`     | The loop's identity — overrides any local `.aiball.yaml`. Match the token. |
| `--project`      | Project name — overrides any local `.aiball.yaml`. Use a per-platform name (e.g. `myapp-android`) until multi-agent-per-project (#391) lands. |

Under the hood the loop exports `AIBALL_URL` / `AIBALL_TOKEN` and an **empty
`AIBALL_SOCK`** (which forces the TCP transport — otherwise the client defaults
to a local socket that doesn't exist on B). These go into both `process.env`
(the claude session **and its MCP server** inherit them) and the loop's
persisted `env` file (the timer + hooks). The env file is written `0600` when it
carries a token. The connection is stored in the loop's plate, so
`claude-loop restart` replays it — a remote loop stays remote.

## Reading attached images

A remote client receives a ticket's attachments as `local:false` with an HTTP
`/uploads/<sha>.<ext>` reference — it can't open them as a local `file://`.
Fetch one over the same authenticated transport:

```bash
aiball download /uploads/<sha>.<ext>          # → saved $TMPDIR/aiball-<sha>.<ext>
aiball download <sha>.<ext> --out shot.png    # explicit path
```

Then `Read` the saved file.

## Live pings

The timer is transport-agnostic: it opens the SSE stream (`/api/events`, behind
the bearer middleware, token attached over TCP) and a slow heartbeat re-checks
via the client as a safety net. So a remote loop is notified of work whether or
not SSE-over-TCP connects cleanly; the heartbeat polling covers the gap.

## Caveats

- **`.mcp.json` must not hardcode `AIBALL_SOCK` / `AIBALL_URL`** — an explicit
  value there would override the remote env the loop injects. Leave them unset
  and let the loop drive the connection.
- `/uploads` is a static mount **outside `/api`** — it is *not* behind the
  bearer middleware. The sha256 path is the capability (effectively
  unguessable). Don't expose the daemon's port to untrusted networks; keep it on
  the tailnet/LAN.
- **Consumer identity:** `aiball auth issue` creates the consumer if it's new, so
  no separate setup step. The daemon authenticates an agent by the **token's**
  consumer — the `--consumer` on B must name the same one the token is bound to.
