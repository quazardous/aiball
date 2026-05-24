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

---

## Boundary 2 — Direct remote (#390) — strongest

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

## Boundary 3 — Proxy node (#394) — ergonomic, and **the weak point** ⚠

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

---

## Mitigation — carry your own token *through* the proxy (#394 QW-A)

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

## Summary

| mode | proof | strength | ergonomics |
|---|---|---|---|
| local UDS | OS uid | uid-level (any same-uid process) | token-less |
| direct #390 | per-consumer token | **strongest** (hard per-consumer) | a token per client |
| proxy #394 | node token | **weakest** (node asserts identity) | token-less locally |
| proxy + own token (QW-A) | per-consumer token | hard proof for the loop | one node secret + provisioned loop token |

**Rules of thumb**

- The **node token is a master credential.** Treat it like the keys to A:
  private network, hosts you control, `chmod 600`, never committed.
- **Local trust is uid-level**, not per-process — fine on a single-user host.
- Want **hard per-consumer proof**? Use **direct mode (#390)**, or carry the
  loop's own token through the proxy (**QW-A**).

**Roadmap (further hardening)**

- **Scope node tokens** to an allow-list of consumer-id prefixes / projects, so a
  leaked node token can't impersonate outside its lane.
- **QW-B** — `claude-loop init` auto-mints the loop's per-consumer token (via a
  human-authed remote issue endpoint), making "one consumer = one token" turnkey
  even behind the proxy.

See also [`REMOTE.md`](./REMOTE.md) § *Trust model & threat model* for the
proxy-mode wiring details.
