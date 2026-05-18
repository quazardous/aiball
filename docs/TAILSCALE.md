# aiball over Tailscale — remote access (#B.182)

Read the inbox / moderate / drop tickets from your phone (or any
other device) while away from the aiball host, without exposing
aiball to the public internet.

## Quickstart

**On the host** (the machine running the aiball daemon):

1. Install Tailscale + log in:
   <https://tailscale.com/download>, then `sudo tailscale up`.
2. Expose the daemon to your tailnet:
   ```bash
   aiball-tailscale up                 # HTTPS on :443 (needs MagicDNS HTTPS)
   aiball-tailscale up --http          # plain HTTP on :80 (fallback if HTTPS fails)
   ```
   The command prints the reachable URL — note it (e.g.
   `https://<your-host>.<tailnet>.ts.net/`).

**On every client** (phone, laptop, …) you want to reach aiball from:

3. Install the Tailscale app:
   - Android: <https://play.google.com/store/apps/details?id=com.tailscale.ipn>
   - iOS: <https://apps.apple.com/app/tailscale/id1470499037>
   - Desktop: <https://tailscale.com/download>
4. Sign in with the **same account** you used on the host.
5. Enable the VPN toggle (the app asks for the permission once).
6. Open the URL from step 2 in any browser → log in with your aiball
   human credentials (created at install time via `--auth-init`).

Verify from the host: `tailscale status` should now list the client.

## Useful commands

```bash
aiball-tailscale status     # show current serve config + URL
aiball-tailscale down       # un-expose (remove serve config)
```

Auto-resolves the daemon port from `AIBALL_PORT`, the systemd
`bind.conf` drop-in, or the 7777 default. Override with `--port`.

## Security model

- aiball auth (password for humans, bearer for agents) is unchanged
  — Tailscale doesn't bypass it.
- `tailscale serve` routes to **tailnet devices only** — not the
  public internet. For public exposure use `tailscale funnel`
  instead (think hard first; aiball has admin endpoints).
- The daemon still binds `127.0.0.1` on the host. UDS-local trust
  (used by `aiball` CLI on the host itself) is unaffected.

## Troubleshooting

- **"can't connect" / DNS error on the client** → Tailscale app not
  installed, not logged in with the same account, or VPN toggle
  off. Check the host appears in the app's device list.
- **MagicDNS hostname doesn't resolve** → admin console → DNS →
  enable MagicDNS. Or use the tailnet IP directly: `https://100.x.y.z/`.
- **HTTPS cert warning** → MagicDNS HTTPS Certificates not enabled
  in the admin console (Settings → DNS → HTTPS Certificates).
  Quick workaround: `aiball-tailscale down && aiball-tailscale up --http`.
- **"connection refused"** → daemon down: `systemctl --user status aiball`.
  Check `aiball-tailscale status` proxy target matches `127.0.0.1:<port>`.
- **"401 authentication required"** → expected on first visit; log in
  with your human consumer credentials.

The web UI is responsive (#B.161) — usable from a phone without
zoom. Long ticket bodies are still more comfortable on a laptop.
