# aiball over Tailscale — remote access (#B.182)

> **Use case**: aiball daemon runs on your home machine. You want to
> read the inbox / moderate / drop tickets from your phone or a
> laptop while away from that machine — without exposing aiball to
> the public internet.

Tailscale gives every device on your tailnet a private IP and a
stable hostname. Reverse-proxying aiball's local port through
`tailscale serve` makes the web UI reachable from any other tailnet
device, end-to-end encrypted, with the daemon still bound only to
`127.0.0.1` on the host.

No aiball config change needed — Tailscale handles the transport.

## Prerequisites

- Tailscale installed + logged in on the **host** (the machine
  running the aiball daemon) AND on every **client** you want to
  reach it from. See <https://tailscale.com/download>.
- Daemon running locally (the standard install: systemd user unit
  bound to `127.0.0.1:7777`).
- Optional but recommended: HTTPS enabled on the tailnet (Settings
  → DNS → MagicDNS + HTTPS Certificates). The HTTPS path below
  requires this; the plain HTTP variant skips it.

## Expose the daemon to your tailnet (HTTPS)

On the host:

```bash
# One-line setup. --bg makes it survive shell exit.
tailscale serve --bg --https=443 127.0.0.1:7777
```

That's it. aiball is now reachable at:

```
https://<your-machine-name>.<your-tailnet>.ts.net/
```

Verify:

```bash
tailscale serve status      # show current config + URL
```

From any tailnet device (phone, laptop), open that URL in a browser
and log in with your aiball human consumer credentials.

## Plain HTTP variant (no HTTPS certs)

If you don't have MagicDNS / HTTPS enabled:

```bash
tailscale serve --bg --http=80 127.0.0.1:7777
```

Access at `http://<your-machine-name>:80/`. Less polished UX (no TLS
in the browser) but zero cert setup.

## Stop / un-expose

```bash
tailscale serve reset       # remove all serve config
# or
tailscale serve --https=443 off    # remove just this route
```

## Security model

- aiball auth (password for humans, bearer token for agents) is
  unchanged — the `bearerAuth` middleware fires regardless of the
  transport. Tailscale doesn't bypass it.
- Tailscale serve only routes to **devices on your tailnet**; it's
  NOT a public-internet exposure. If you ALSO want public exposure,
  use `tailscale funnel` instead of `serve` — but think hard before
  doing so (aiball has admin endpoints).
- The daemon still listens on `127.0.0.1:7777` on the host. UDS-local
  trust (used by `aiball` CLI on the host itself) is unaffected.

## Mobile UI

The web UI is responsive (#B.161) — usable from a phone browser
without zoom. Quick triage / moderation works fine on a small
screen. Composing long ticket bodies is more comfortable with a
keyboard; you'll probably draft those on a laptop.

## Troubleshooting

- **"connection refused"** from a tailnet device → check the daemon
  is up: `systemctl --user status aiball`. Check `tailscale serve
  status` matches `127.0.0.1:7777`.
- **"401 authentication required"** → expected on first visit.
  Log in with your human consumer credentials (created at install
  time via the `--auth-init` URL).
- **MagicDNS hostname doesn't resolve** → Tailscale admin console →
  DNS → enable MagicDNS. Or use the tailnet IP directly:
  `https://100.x.y.z/`.
- **HTTPS cert warning** → MagicDNS HTTPS certs need to be enabled
  in the admin console (Settings → DNS → HTTPS Certificates).
