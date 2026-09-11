/*
 * The tailnet section of the menu, as data and pure functions — import-free
 * (no `gi://`, no `resource://`) so a plain Node test can pin it, like
 * daemonActions.js.
 *
 * Everything is READ from local commands, so the extension still holds no
 * token: the aiball CLI says whether a tailscale provider is configured, and
 * tailscale itself says whether it is connected and what it serves.
 *
 * There is deliberately no "take it down" entry. `aiball providers down` runs
 * `tailscale serve reset`, which wipes the machine's WHOLE serve configuration,
 * not just aiball's entry — too much for a menu item one stray click away. It
 * stays a command-line gesture.
 */

export const TAILNET = Object.freeze({
    providers: ['aiball', 'providers', 'status', '--json'],
    status: ['tailscale', 'status', '--json'],
    serve: ['tailscale', 'serve', 'status', '--json'],
    // `--all`: bring the provider up even when it is not marked autostart —
    // pressing the button is the explicit ask.
    expose: ['aiball', 'providers', 'up', '--all'],
});

function parse(text) {
    try {
        return JSON.parse(String(text ?? ''));
    } catch {
        return null;
    }
}

/** The configured tailscale provider, or null when none is (the section then stays hidden). */
export function tailscaleProvider(providersStdout) {
    return parse(providersStdout)?.config?.tailscale ?? null;
}

/** Whether tailscale is logged in and running, and this machine's tailnet name. */
export function tailscaleConnection(statusStdout) {
    const j = parse(statusStdout);
    const dns = j?.Self?.DNSName;
    return {
        connected: j?.BackendState === 'Running',
        host: dns ? String(dns).replace(/\.$/, '') : null,
    };
}

const LOCAL_PROXY = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/?$/;

/**
 * The URL tailscale serves the board on: a handler proxying to the board's
 * local port, preferably on the configured path. Null when nothing serves it.
 */
export function aiballTailnetUrl(serveStdout, boardPort, path) {
    const j = parse(serveStdout);
    if (!j?.Web) return null;
    const wanted = path || '/';
    let fallback = null;
    for (const [hostPort, web] of Object.entries(j.Web)) {
        for (const [handlerPath, handler] of Object.entries(web?.Handlers ?? {})) {
            const m = LOCAL_PROXY.exec(String(handler?.Proxy ?? ''));
            if (!m || Number(m[1]) !== Number(boardPort)) continue;
            const port = hostPort.split(':').pop();
            const https = j.TCP?.[port]?.HTTPS === true;
            const defaultPort = https ? '443' : '80';
            const host = port === defaultPort ? hostPort.slice(0, -(port.length + 1)) : hostPort;
            const url = `${https ? 'https' : 'http'}://${host}${handlerPath}`;
            if (handlerPath === wanted) return url;
            fallback ??= url;
        }
    }
    return fallback;
}

/**
 * What the section shows. `canExpose` only when bringing the provider up can
 * change something: configured, enabled, tailscale connected, board not served.
 */
export function tailnetMenu({provider, connection, url}) {
    if (!provider) return {visible: false, line: '', url: null, canExpose: false};
    if (provider.enabled === false)
        return {visible: true, line: 'tailnet: provider disabled in the config', url: null, canExpose: false};
    if (!connection?.connected)
        return {visible: true, line: 'tailnet: Tailscale is not connected', url: null, canExpose: false};
    if (url) return {visible: true, line: `tailnet: ${url}`, url, canExpose: false};
    return {visible: true, line: 'tailnet: not served', url: null, canExpose: true};
}
