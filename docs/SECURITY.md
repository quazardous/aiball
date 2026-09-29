# aiball — security model & limits

aiball is **local-first**. Its security rests on a few simple trust boundaries.
This page explains them plainly, with diagrams, and — most importantly — says
**where the limits are**, so you deploy each mode where it's safe.

On every request the daemon answers one question: **who is this consumer?**
The *proof* of that identity is what changes between transports. There are three
boundaries, from strongest-but-least-ergonomic to most-ergonomic-but-weakest.

---

## Boundary 1 — Local, over the Unix socket (same host)

```
   same host (your uid)
 ┌───────────────────────────────────────────────┐
 │  [ loop / CLI / MCP / web ]                     │
 │        │  UDS, chmod 600                         │
 │        │  header: x-aiball-consumer: alice       │
 │        ▼                                         │
 │  [ aiball daemon + DB ]                          │
 │     trusts it because the socket is same-uid     │
 └───────────────────────────────────────────────┘
   PROOF = OS uid.    IDENTITY = the header (or "human" if absent).
```

**Limit:** the boundary is the **uid**, not the process. Any process running as
your user can open the socket and **claim any consumer**. That's fine for a
single-user host (it's *your* machine), but it is **not** a per-process or
per-consumer guarantee.

### The same boundary over TCP — the machine secret

Where the socket is not used — Windows, whose daemon listens on TCP only — the
same proof travels as a file instead of a socket mode:

```
   same host (your user)
 ┌──────────────────────────────────────────────────────┐
 │  [ loop / CLI / MCP / GUI ]                            │
 │        │  TCP to 127.0.0.1 (loopback)                  │
 │        │  Bearer <machine secret>                      │
 │        │  header: x-aiball-consumer: alice             │
 │        ▼                                               │
 │  [ aiball daemon ]  reads <AIBALL_HOME>/machine-secret │
 │     trusts it: same secret AND a loopback peer         │
 └──────────────────────────────────────────────────────┘
   PROOF = reading a file only your user can read.   IDENTITY = the header.
```

The daemon writes `<AIBALL_HOME>/machine-secret` once (`0600`; on Windows, the
user profile's permissions) and keeps it across restarts. A caller bearing it
**from the loopback** is treated as a socket caller — `caller.machine` is
`local` — and reaches what only local callers may: the loops' controls
(`loop.*`), `session.*`, a folder's `project.init`, `daemon.reload`.

- **Both conditions.** The secret is the proof. The loopback check makes a
  copied secret useless from another host. The loopback alone proves nothing:
  another user of the machine reaches it, and so does whatever a local reverse
  proxy (`tailscale serve`) forwards there.
- **Never looked up as a token**, and never relayed: a proxy node checks it and
  vouches upstream with its own token, as for any caller without one.
- **Clients send it only to a loopback address** (`src/client.ts`), and prefer it
  to `cli-env` there, as they prefer the socket.
- **Limit:** the same as the socket's. Anything running as your user can read
  the file and claim any consumer; an administrator of the machine can read it,
  as root can open the socket.

---

## Boundary 2 — Direct remote — strongest

```
   host B                          host A
 [ loop ] ──HTTP, Bearer <agent token for alice>──► [ aiball daemon + DB ]
                                                        token ─► consumer "alice"
                                                        x-aiball-consumer IGNORED
   PROOF = a per-consumer token (the token *is* the identity).
```

Each client carries **its own** token, bound to one consumer. The token wins; a
spoofed `x-aiball-consumer` header is ignored. This is **hard per-consumer
proof**.

**Limit:** every remote client needs its own token provisioned
(`aiball auth issue --consumer <id>` on A). Less turnkey — that's the price of
strictness.

---

## Boundary 3 — Proxy node — ergonomic, and **the weak point** ⚠

A proxy node is a local daemon on B that **relays** to A. Local clients on B keep
talking token-less over the UDS; the node injects **one** credential for the
whole machine and forwards each caller's `x-aiball-consumer`.

```
   host B (proxy, NO local DB)                 host A
 [ loop ]──UDS token-less──┐
   x-aiball-consumer: alice │
 [ CLI ]──────────────────►[ proxy ]──HTTP, Bearer <NODE token>──►[ daemon + DB ]
                            (forwards x-aiball-consumer)  │
                                                          ▼
                              node token says "this NODE is legit"
                              ⇒ daemon TRUSTS x-aiball-consumer = alice
                                (auto-creates the consumer if new)

   PROOF = the node token (proves the NODE, not the consumer).
           the identity is *asserted* by the node — no per-consumer proof.
```

This is the **X-Forwarded-For model**: a whitelisted reverse-proxy is allowed to
declare the real client. It's the **cross-host analog of Boundary 1's same-uid**
— a coarse proof (the node is legit) plus an asserted identity (the header).

**⚠ This is the weak point of the whole system.** A **node token is
impersonation-capable and unscoped**: anyone holding it can assert **any**
consumer on A — a bigger blast radius than an agent token (bound to one
consumer). So:

- **Private network only** — tailnet / trusted LAN. Never expose a node-token
  endpoint publicly.
- **Only between hosts you control** — you're federating *your own* machines,
  not opening a delegation endpoint to third parties.
- Keep `proxy.token` **chmod 600**; **never commit** it.

### How a node gets its token

Two ways, and both end with a human deciding.

**Pairing** (`aiball proxy pair`) exists so the token never travels by hand.
The node asks; a moderator approves in the web UI; the node collects the token
itself, once. Approving is what mints it — before that, a request holds no
credential at all.

That flow needs one route to answer a caller who has proved nothing, since a
node has no credential yet. It is the only such write route in aiball, and it is
kept narrow on purpose:

- **It can mint nothing.** It records an intent. The worst an unknown caller
  achieves is a row you will not recognise and will not approve.
- **It answers only inside a window** a moderator opened, minutes long, shut by
  default and shut again by any restart. A gate should fail closed.
- **It is rate-limited per IP**, so an accident cannot bury a real request among
  hundreds of fake ones.
- **The short code is compared on both screens.** It is not a secret and does
  not protect the route; it protects *you*, by tying the row you approve to the
  machine you are standing at.
- **Requests expire**, and an approved token is handed over exactly once — after
  which the request keeps no copy.
- **What the caller says about itself is shown as a claim.** A request carries a
  label and the host name the machine resolved for itself, which make the row
  recognisable — but they are chosen by a caller that has proved nothing, and
  the panel marks them as such. The address the hub observed is the only fact
  it did not receive from the asker; the short code, compared on both screens,
  is what actually ties the row to your machine.

One consequence worth stating plainly: **an approved pairing restarts the node's
daemon**. Relaying is decided when the daemon builds its HTTP app, so it cannot
be switched on in place — through the service manager on Linux, and on Windows
by stopping so the tray watchdog starts it again, which it only does while that
watchdog is provably alive. That restart is bounded on both ends — it happens only
when a request written by an explicit `aiball proxy pair` on that machine is
approved by a human on the hub, and the node's own record of the request is
consumed by every outcome, so nothing left on disk can make it reconfigure
itself twice. That record holds no secret: the handle in it can watch a request,
never approve one.

**Minting by hand** (`aiball auth issue --node`) stays available and is the
right tool for scripted installs. The trade is the one this page warns about
everywhere else: you are then responsible for moving a credential between two
machines without it being seen or kept.

---

## Mitigation — carry your own token *through* the proxy (QW-A)

You don't have to choose globally. The proxy injects the node token **only as a
fallback**: a caller that already presents its **own** agent token keeps it
end-to-end.

```
   host B (proxy)                              host A
 [ loop w/ own token T_alice ]
        └─Bearer T_alice──►[ proxy ]──Bearer T_alice (preserved)──►[ daemon ]
                                                       token ─► "alice" (HARD proof)

 [ web UI / ad-hoc CLI ]──token-less──►[ proxy ]──Bearer NODE + x-consumer──► vouched
```

So the **writes that matter** (the loop's) carry **per-consumer proof**, and the
node token only covers genuinely token-less stragglers. A leaked node token can
then impersonate **only** those token-less clients — the blast radius shrinks in
practice.

---

## Closing the weak point entirely — strict mode

QW-A *shrinks* the blast radius; **strict mode removes it.** Set `strict: true`
in the `proxy:` block (or `aiball proxy init --strict`) and the proxy **never
injects the node token as a fallback**. Every relayed request must carry its own
per-consumer bearer — a token-less call is **rejected with 401 at the proxy**,
before any forward.

```yaml
proxy:
  url: https://A-host:7777
  strict: true          # node token is never injected; per-consumer bearer or 401
```

```
   host B (proxy, strict)                        host A
 [ loop w/ own token T_alice ]
        └─Bearer T_alice──►[ proxy ]──Bearer T_alice──►[ daemon ] ─► "alice" (HARD proof)

 [ web UI / ad-hoc CLI ]──token-less──►[ proxy ]──► 401 (rejected, never forwarded)
```

With strict on, **the node can no longer *assert* an identity** — there is no
master-credential fallback left, so the cross-host weak point is gone: A
authenticates **every** write per-consumer. The trade-off is ergonomic — each
local client must be provisioned with its own token minted on A
(`aiball auth issue --consumer <id>`); token-less clients (the web UI, ad-hoc
CLI over the UDS) stop working through the proxy. That's why strict is **opt-in
(default off)** — turning it on is a deliberate "I've provisioned per-consumer
tokens and want zero node-asserted identity" choice.

The only residue is the **same-uid-on-B** boundary (a process running as the
same OS user as the proxy can read its config / a local token) — that's the uid
frontier, true everywhere and out of scope for tokens.

### Node-managed token store — strict without losing convenience

Strict mode makes every client carry a per-consumer A-token, which means the
A-token lives on each client. The **node-managed token store** keeps that
custody on the node instead: B holds a small map `{local token → A-token}`, hands
each client a **local** token, and **swaps** it for the mapped A-token at egress.

```
   host B (proxy, strict + store)                 host A
 [ loop ]──Bearer T_local_alice──►[ proxy ]──swap──Bearer T_A_alice──►[ daemon ]
                                  store: T_local_alice → T_A_alice          └─► "alice"
```

So the client only ever holds a **local** token; the real A-token never leaves
the node. Benefits: **central custody + rotation/revocation on B** (rotate the
A-token in one place, clients keep their stable local token), while A still gets
**hard per-consumer proof** (the swapped A-token *is* the proof). A bearer that
isn't in the store passes through untouched (a client carrying its own A-token,
QW-A). Wiring:

```bash
# on A — mint the per-consumer A-token
aiball auth issue --consumer alice           # → aiball-<…>

# on B — map a local token to it (generates the local token)
aiball proxy token add --consumer alice --remote aiball-<…>
# → hand the printed LOCAL token to alice's client; restart B
```

The same-uid-on-B residue still applies (the store is `chmod 600`, but a process
as the same OS user can read it) — the uid frontier, as always.

---

## Authorship — the author is the caller

The author of every write (`by_agent` of a message, `set_by` of a tag,
`answered_by` of an answer, `decided_by` of a decision) is the consumer the
request authenticates as, never a name in the body; a body naming someone else
is refused (`AUTHOR_MISMATCH`). Its strength is the boundary's: bound to the
token on a direct remote, but on the local socket and through a proxy node the
identity is the `x-aiball-consumer` header the caller declares — there it keeps
authorship consistent, it does not prove it.

## The bus — authenticated once per connection

The bus ([`API-BUS.md`](./API-BUS.md)) decides who a caller is with the same
function as `/api`, once, on the request that opens the connection; every call
on it runs as that caller. The boundaries above hold unchanged: the local
socket trusts the same user, a token binds the identity over TCP, and a caller
relayed by a proxy node is marked so: a method closed to relayed callers (the
loop controls) refuses it, whoever it names. What differs is
time: a token revoked in the daemon closes the connections that rest on it at
once; one deleted by another process (the CLI) is caught within the keepalive
period, 25 seconds.

## Attaching to a loop (planned)

The protocol in [`LOOP-HOST.md`](./LOOP-HOST.md) will listen on
`<state_dir>/attach.sock`, mode `0600`: the same boundary as `loop.sock`,
whoever can open the loop's state directory can watch it and type into it.
There is no token; it is not reachable from another host except through the
daemon, which will relay it behind its own authentication.

## Uploads — capability URLs

A file pasted or attached in a thread is stored under its SHA-256 and cited in
texts as `/uploads/<sha>.<ext>`. That web path is served **outside the API's
authentication**, on purpose: a browser's `<img>` sends no token. Anyone who can
reach the daemon's TCP port and knows a file's 64-hex-digit hash can read it —
the hash is the capability, and it cannot be guessed, but it travels with every
text that cites the file.

Clients that are not a browser read the same file under the API, behind its
authentication: `/api/uploads/<sha>` (the extension is optional). Over the local
socket both are equally trusted.

## Summary

| mode | proof | strength | ergonomics |
|---|---|---|---|
| local UDS | OS uid | uid-level (any same-uid process) | token-less |
| local TCP + machine secret | a file only the user reads, from the loopback | uid-level, as the socket | automatic (clients read it) |
| direct | per-consumer token | **strongest** (hard per-consumer) | a token per client |
| proxy | node token | **weakest** (node asserts identity) | token-less locally |
| proxy + own token (QW-A) | per-consumer token | hard proof for the loop | one node secret + provisioned loop token |
| **proxy strict** | per-consumer token (mandatory) | **strongest** (no node-asserted identity, 401 otherwise) | a token per local client, no token-less fallback |
| **proxy strict + node store** | per-consumer token (node swaps local→A) | **strongest** (hard per-consumer at A) | clients hold a local token, A-token custody + rotation on the node |

**Rules of thumb**

- The **node token is a master credential.** Treat it like the keys to A:
  private network, hosts you control, `chmod 600`, never committed.
- **Local trust is uid-level**, not per-process — fine on a single-user host.
- Want **hard per-consumer proof**? Use **direct mode**, carry the loop's
  own token through the proxy (**QW-A**), or **kill the node-asserted identity
  outright** with **strict mode** (`proxy.strict: true`).

**Roadmap (further hardening)**

- **QW-B** — `claude-loop init` auto-mints the loop's per-consumer token (via a
  human-authed remote issue endpoint), making "one consumer = one token" turnkey
  even behind the proxy → makes strict mode painless (no manual provisioning).
- **Scope node tokens** to an allow-list of consumer-id prefixes / projects, so a
  leaked node token can't impersonate outside its lane (relevant only in
  non-strict mode, where a node token still exists).

See also [`REMOTE.md`](./REMOTE.md) § *Trust model & threat model* for the
proxy-mode wiring details.
