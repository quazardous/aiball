# aiball over Tailscale — remote access

Read the inbox / moderate / drop tickets from your phone (or any
other device) while away from the aiball host, without exposing
aiball to the public internet.

Remote access is a **host-level provider** managed by the daemon — there's no
manual command to run each time. You configure it once; the daemon brings it up
at boot.

## Quickstart

**On the host** (the machine running the aiball daemon):

1. Install Tailscale + log in:
   <https://tailscale.com/download>, then `sudo tailscale up`.
2. Configure the tailscale provider (writes the global `providers:` block):
   ```bash
   aiball init tailscale            # HTTPS on :443 (needs MagicDNS HTTPS)
   aiball init tailscale --http     # plain HTTP on :80 (fallback if HTTPS fails)
   ```
3. Bring it up:
   ```bash
   aiball providers up
   ```
   That's the whole apply step. The systemd user unit already carries an
   `ExecStartPost=… aiball providers up` hook (shipped in the unit, not
   generated), so every daemon (re)start re-exposes it automatically — you
   never re-run `install.sh` for this. `aiball providers up` just does it
   *now* without waiting for a restart.
4. Confirm + get the URL:
   ```bash
   aiball status        # shows: proxy: tailscale [...] — up → https://<host>.<tailnet>.ts.net
   ```

**On every client** (phone, laptop, …) you want to reach aiball from:

5. Install the Tailscale app:
   - Android: <https://play.google.com/store/apps/details?id=com.tailscale.ipn>
   - iOS: <https://apps.apple.com/app/tailscale/id1470499037>
   - Desktop: <https://tailscale.com/download>
6. Sign in with the **same account** you used on the host.
7. Enable the VPN toggle (the app asks for the permission once).
8. Open the URL from step 4 in any browser → log in with your aiball
   human credentials (created at install time by the auth bootstrap —
   the setup URL `install.sh` printed; re-mint with `aiball auth reinit`).

Verify from the host: `tailscale status` should now list the client.

## Managing the provider

```bash
aiball providers status     # configured providers + live serve status + URL
aiball providers up         # bring up every enabled provider now
aiball providers down       # un-expose (tailscale serve reset)
aiball status               # daemon + spool + the proxy line, all in one
```

Config lives in the **global** `~/.config/aiball/config.yaml` (remote access is
host-level, not per-project — see [`CONFIGS.md`](./CONFIGS.md)):

```yaml
providers:
  tailscale:
    enabled: true       # default true when the block is present
    autostart: true     # bring up with the daemon (systemd ExecStartPost)
    mode: https         # https (default) | http
    # port: 8443        # optional listen-port override (default 443/80)
    # path: /aiball     # optional: serve under a path instead of root /
```

The daemon auto-resolves the proxy target port from `AIBALL_PORT`, the systemd
`bind.conf` drop-in, or the 7777 default.

By default aiball serves at the root path `/` on the listen port, which claims
the whole port. Set `path: /aiball` to serve under a sub-path instead (via
`tailscale serve --set-path`): that frees `/` and the other paths on the same
443 so you can Funnel-expose another local service on it — required when a
provider's webhook insists on port 443 (e.g. it rejects `:8443`). The
`--set-path` serve entry is additive, so it coexists with other handlers across
daemon restarts. (Caveat: `aiball providers down` runs `tailscale serve reset`,
which clears the node's whole serve config — re-add any coexisting handler
after a manual down.)

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
  Quick workaround: set `mode: http` (or `aiball init tailscale --http`)
  then `aiball providers down && aiball providers up`.
- **"connection refused"** → daemon down: `systemctl --user status aiball`.
  Check `aiball providers status` proxy target matches `127.0.0.1:<port>`.
- **proxy not up after a reboot** → the installed systemd unit predates the
  autostart hook. Re-run `bash install.sh && systemctl --user restart aiball`.
- **"401 authentication required"** → expected on first visit; log in
  with your human consumer credentials.

The web UI is responsive — usable from a phone without
zoom. Long ticket bodies are still more comfortable on a laptop.
