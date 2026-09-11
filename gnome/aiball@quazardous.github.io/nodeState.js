/*
 * What the indicator says about the daemon, as pure functions — import-free
 * like daemonActions.js, so a plain Node test can pin it.
 *
 * A proxy node is a local daemon that relays every `/api/*` call to a remote
 * aiball. There, `/api/health` answers for the REMOTE: reading it alone made the
 * extension report "daemon down" while the local relay ran fine, and present the
 * remote board's counters as local. `/api/node` is answered locally and never
 * relayed, so it is read first — the way the Windows tray already does.
 */

export const NODE_PATH = '/api/node';
export const HEALTH_PATH = '/api/health';

export const ICON_LOCAL = 'aiball-symbolic.svg';
export const ICON_PROXY = 'aiball-proxy-symbolic.svg';

/**
 * `node` is the /api/node body, or null when it could not be read (daemon down,
 * or a daemon too old to have the route — it then falls back to health, as the
 * tray does). `health` is the /api/health body, or null.
 */
export function daemonView(node, health) {
    if (node?.proxy === true) {
        return health?.ok
            ? {state: 'proxy-up', upstream: node.upstream ?? null, version: health.version ?? null}
            : {state: 'proxy-remote-down', upstream: node.upstream ?? null, version: null};
    }
    if (node?.ok || health?.ok) return {state: 'up', upstream: null, version: health?.version ?? null};
    return {state: 'down', upstream: null, version: null};
}

function withSlash(url) {
    if (!url) return null;
    const s = String(url);
    return s.endsWith('/') ? s : `${s}/`;
}

/**
 * How a view looks. `localUp` drives the start / stop / restart entries, which
 * act on the local service — on a proxy node, the relay. The remote's own state
 * only decides the colour and whether its counters are shown.
 */
export function presentation(view, localBoardUrl) {
    const upstream = view.upstream ?? 'unknown upstream';
    switch (view.state) {
    case 'proxy-up':
        return {
            icon: ICON_PROXY, styleClass: null, localUp: true, showCounts: true,
            countsPrefix: 'remote board: ',
            stateLine: `proxy node → ${upstream} — remote reachable${view.version ? ` (${view.version})` : ''}`,
            // The relay only serves a landing page: the board worth opening is the remote one.
            boardUrl: withSlash(view.upstream) ?? localBoardUrl,
        };
    case 'proxy-remote-down':
        return {
            icon: ICON_PROXY, styleClass: 'aiball-upstream-down', localUp: true, showCounts: false,
            countsPrefix: '',
            stateLine: `proxy node → ${upstream} — remote unreachable`,
            boardUrl: withSlash(view.upstream) ?? localBoardUrl,
        };
    case 'up':
        return {
            icon: ICON_LOCAL, styleClass: null, localUp: true, showCounts: true, countsPrefix: '',
            stateLine: `daemon up${view.version ? ` — ${view.version}` : ''}`,
            boardUrl: localBoardUrl,
        };
    default:
        return {
            icon: ICON_LOCAL, styleClass: 'aiball-down', localUp: false, showCounts: false, countsPrefix: '',
            stateLine: 'daemon down',
            boardUrl: localBoardUrl,
        };
    }
}

/** On a proxy node, start / stop / restart act on the local relay, and say so. */
export function actionLabel(label, proxy) {
    return proxy ? String(label).replace('the daemon', 'the relay') : String(label);
}
