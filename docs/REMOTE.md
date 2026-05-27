# Remote aiball — run a local `claude-loop` against a remote daemon

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

## The two types of remote

aiball has **two types** of remote. They do the same job (a loop on B against a
daemon on A) but differ mainly by the **token** — and that single choice decides
per-client config, the proof A gets, and the blast radius if a token leaks:

| | **Type 1 — Proxy** | **Type 2 — Direct** |
|---|---|---|
| what | a **local aiball daemon on B** relays *all* local clients to A | each loop on B talks **straight** to A |
| token | **node** token | **agent** token |
| minted on A by | `aiball auth issue --node` | `aiball auth issue --consumer <id>` |
| bound to | nothing (`consumer_id` NULL, `kind: node`) | one consumer |
| proof at A | per-**node** + *asserted* identity (`x-aiball-consumer`) | **per-consumer** (hard) |
| client config | local clients are **token-less** (UDS) | each loop carries its own token |
| best for | a busy host, many clients, ergonomics | one / a few loops, strict identity |
| leak blast radius | **impersonate any consumer** (sensitive) | one consumer |

Rule of thumb: **Proxy** for a host running several clients (loops, MCP, CLI, web
UI) that should all "just work" against A without per-client tokens; **Direct**
for a single loop or when you want hard per-consumer proof.

The two coexist, and you can even **mix** them (a loop carrying its own agent
token *through* the proxy) or **harden** the proxy so it never speaks for anyone
(`proxy.strict`). Each type below opens with a **quickstart**, then the details.

## Type 1 — Proxy

Run a **local aiball daemon on B in proxy mode**; it relays every local client to
A under **one node token**, so loops, MCP, CLI and the web UI on B all stay
token-less (localhost / UDS, SSE included) — no per-client remote config.
Recommended for a busy host.

### Quickstart

```bash
# on A — mint the node service token (no consumer; it's the node's credential)
aiball auth issue --node            #  → aiball-<48 hex>

# on B — point this daemon at A as a proxy node (writes the proxy: block)
aiball proxy init --url https://<A-host>:7777 --token aiball-<48 hex>
systemctl --user restart aiball     # boot as a relay
```

`install.sh` can do the B side in one shot:
`bash install.sh --proxy-url https://<A-host>:7777 --proxy-token aiball-<48 hex>`.

Either way it writes the **global** config (`~/.config/aiball/config.yaml`):

```yaml
proxy:
  url: https://<A-host>:7777
  token: aiball-<48 hex>      # a NODE token: aiball auth issue --node
  # optional, declared by THIS node :
  node:
    label: "my-laptop"        # default = os.hostname()
  no_claim_consumers:         # consumers that should NEVER auto-claim
    - aiball-windows          # — `ticket_engage` only returns tickets
                              #   explicitly assigned to them. Can still
                              #   receive a push, comment, resolve.
```

That's it — every local client on B (loops, MCP, CLI, web UI) now reaches A
token-less over the UDS / `127.0.0.1`, as if A were local.

The `no_claim_consumers` list (per-node config) is OR'd with the upstream
`consumers.can_claim=false` flag (set via the admin UI on A): a consumer
becomes assignment-only if *either* gate triggers. Useful when the same
consumer should be no-claim only when running through THIS node, or when you
want the policy to live with the agent's machine rather than the admin UI.
Implemented via a `x-aiball-no-claim: 1` header the proxy injects on
forwarded requests for matching consumers — the upstream's claimable lens
short-circuits the global pool to "assigned to me" only.

> Today the proxy relays the data plane; **launching a loop on B from A's web UI**
> needs a reverse control channel (A→B) and is a follow-up — local launch
> on B works now.

### How it works

The B daemon becomes a **transparent relay**: it forwards `/api/*` and
`/uploads/*` to A (injecting the bearer), pipes A's SSE (`/api/events`) back to
local subscribers, and keeps no local DB. Local clients on B talk to the UDS /
`127.0.0.1` token-less, exactly as if A were local. If A is unreachable the proxy
answers 502 and the local client spools the write for replay.

### The node token — why the proxy needs a *special* token

A proxy node relays **many** local clients (loops, MCP, CLI, web UI), each with
its **own** consumer identity. It forwards each caller's `x-aiball-consumer`
header and injects **one** bearer for the whole node. So A must trust that header
— but only *because* the node is legit. That's the **X-Forwarded-For model**: a
whitelisted reverse-proxy is allowed to assert the real client.

A regular **agent** token can't do this — for agent tokens the token wins and the
header is ignored (everything would be attributed to the node). So the node uses
a dedicated **node token** (`kind: node`): it proves the *node* is legit and lets
it **assert** the relayed identity via `x-aiball-consumer` (auto-creating the
consumer on first sight). A node token is **not** human — the delegated
consumer's own privileges apply.

> Identity, two ways: the **node token** proves the *node* is legit; a regular
> **agent token** (direct mode) proves the *consumer* is legit. Pick one.

### Trust model & threat model

A fair question: A trusts the forwarded `x-aiball-consumer` **on the node token
alone** — there's no *per-consumer* proof. Is that safe?

It's the **same shape as aiball's existing local-trust**, extended one hop. Over
the UDS, the only proof is **same-uid + `chmod 600`**: any process of your uid can
already assert *any* `x-aiball-consumer` (it defaults to `human`). aiball has
**never** required per-consumer proof locally — the uid *is* the boundary. The
node token is just the **cross-host analog of "same uid"**: a coarse proof (the
node is legit) plus an asserted identity (the header). So the forwarded identity
*does* have a proof — the node token — it's simply node-level, not per-consumer,
exactly like local.

The trade-off vs **direct mode** is deliberate:

| | proof at A | local clients | leak blast radius |
|---|---|---|---|
| **proxy (node token)** | node-level | token-less (UDS) | **impersonate any consumer** |
| **direct (agent token)** | per-consumer | each needs a remote token | one consumer |

So a **node token is impersonation-capable** — more sensitive than an agent token
(which is bound to a single consumer) because it is **not scoped** to any consumer
or project. Treat it accordingly:

- **Private network only** — tailnet (see [`TAILSCALE.md`](./TAILSCALE.md)) or
  trusted LAN. Never expose a node-token endpoint publicly.
- **Deploy only between hosts you control** — you are federating *your own*
  machines, not opening a delegation endpoint to third parties.
- Keep `proxy.token` `chmod 600` in the global config; never commit it.

If you need **per-consumer hard proof**, use **Type 2 — Direct** (each loop
carries its own agent token, end-to-end). The two types coexist on purpose —
pick ergonomics (proxy) or strictness (direct) per deployment.

**You can also mix the two *through* the proxy**: a caller that
presents its **own** agent token keeps it end-to-end — the proxy injects the
node token **only as a fallback** for token-less callers. So a loop configured
with its own per-consumer token gets hard proof at A *and* the proxy's single
egress point + spool resilience; the node token then only covers the genuinely
token-less local clients (web UI, ad-hoc CLI). This shrinks the node token's
blast radius in practice — the writes that matter (the loop's) carry their own
proof, so a leaked node token can impersonate only the token-less stragglers.

**To close the weak point entirely, use strict mode**: `proxy.strict:
true` (or `aiball proxy init --strict`) tells the proxy to **never inject the
node token** — every relayed request must carry its own per-consumer bearer, and
a token-less call is rejected with **401** at the proxy. The node can no longer
assert an identity, so A authenticates every write per-consumer. Trade-off:
each local client must be provisioned with its own token (`aiball auth issue
--consumer <id>`), and token-less clients (web UI / ad-hoc CLI over the UDS) stop
working through the proxy — that's why it's **opt-in**. See
[`SECURITY.md`](./SECURITY.md) § *Closing the weak point entirely*.

**To keep strict ergonomic, use the node-managed token store**: instead
of putting an A-token on each client, B holds a `{local token → A-token}` map and
**swaps** an incoming local bearer for the mapped A-token at egress. Clients hold
only a *local* token; the A-token's custody (and rotation/revocation) stays on
the node, while A still gets hard per-consumer proof.

```bash
# on A — mint the per-consumer A-token
aiball auth issue --consumer alice               # → aiball-<…>
# on B — map a local token to it (the local token is generated + printed)
aiball proxy token add --consumer alice --remote aiball-<…>
aiball proxy token list                          # local→remote, tokens masked
aiball proxy token revoke alice                  # by consumer or local token
systemctl --user restart aiball                  # the store is read at boot
```

The store lives at `~/.config/aiball/proxy-tokens.yaml` (chmod 600). A bearer not
in the store passes through untouched (a client carrying its own A-token).

## Type 2 — Direct

Each `claude-loop` on B points at A **directly**, carrying its **own agent
token** end-to-end. Per-loop config; A authenticates every write per-consumer
(hard proof). Use this for one or a few loops, or when identity strictness
matters more than ergonomics.

### Quickstart

```bash
# on A — mint a token for the loop's consumer (created on the fly if new)
aiball auth issue --consumer my-remote-agent      #  → aiball-<48 hex>

# on B — start the loop pointed at A, in the project dir
claude-loop start \
  --aiball-url   http://<A-host>:7777 \
  --aiball-token aiball-<48 hex> \
  --consumer     my-remote-agent \
  --project      my-project
```

Make sure the daemon is reachable from B — over Tailscale see
[`TAILSCALE.md`](./TAILSCALE.md) (`tailscale serve`), over a LAN bind/forward the
daemon's port (default `7777`).

> The daemon authenticates an agent by **the token's** consumer — the
> `--consumer` flag on B must name the **same** consumer the token is bound to
> (a mismatch is ignored for agent tokens; the token wins).

### Flags

| Flag | Effect |
|------|--------|
| `--aiball-url`   | Target the remote daemon over HTTP (**required** for remote mode). |
| `--aiball-token` | Bearer token from the quickstart (**required** with `--aiball-url`). |
| `--consumer`     | The loop's identity — overrides any local `.aiball.yaml`. Match the token. |
| `--project`      | Project name — overrides any local `.aiball.yaml`. Use a per-platform name (e.g. `myapp-android`) until multi-agent-per-project lands. |

### Persist it — `claude-loop init` (so plain `start` reconnects)

To avoid re-passing the flags every time, persist the connection once:

```bash
# on machine B, in the project dir
claude-loop init \
  --aiball-url   http://<A-host>:7777 \
  --aiball-token aiball-<48 hex> \
  --consumer     my-remote-agent \
  --project      my-project
```

This writes a `remote:` block to `.aiball.local.yaml` (chmod `600`, **git-ignored**
— it carries a token) **and** bootstraps the project (`.mcp.json` + `.aiball.yaml`,
the existing `claude-loop init` behavior). Afterwards a plain **`claude-loop start`**
(no flags) in that dir slaves to A; per-start flags still override.

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
