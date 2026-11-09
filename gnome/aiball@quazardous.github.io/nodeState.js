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
        // The node's copy of the board, when it keeps one.
        const replica = node.replica ? {replica: node.replica} : {};
        // #4874 — whether it may take the board over now, and why not.
        if (node.switch) replica.switch = node.switch;
        return health?.ok
            ? {state: 'proxy-up', upstream: node.upstream ?? null, version: health.version ?? null, ...replica}
            : {state: 'proxy-remote-down', upstream: node.upstream ?? null, version: null, ...replica};
    }
    if (node?.ok || health?.ok) return {state: 'up', upstream: null, version: health?.version ?? null};
    return {state: 'down', upstream: null, version: null};
}

/** The node's copy, in a few words: complete, or how far along; '' without one. */
export function replicaWords(replica) {
    if (!replica) return '';
    if (replica.complete) return 'copy of the board complete';
    const docs = replica.total ? `copy of the board: ${replica.kept}/${replica.total}` : `copy of the board: ${replica.kept} documents`;
    return replica.files && replica.files.total > 0 ? `${docs}, files ${replica.files.kept}/${replica.files.total}` : docs;
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
            stateLine: `proxy node → ${upstream} — remote reachable${view.version ? ` (${view.version})` : ''}${view.replica ? ` — ${replicaWords(view.replica)}` : ''}`,
            // The relay only serves a landing page: the board worth opening is the remote one.
            boardUrl: withSlash(view.upstream) ?? localBoardUrl,
        };
    case 'proxy-remote-down':
        return {
            icon: ICON_PROXY, styleClass: 'aiball-upstream-down', localUp: true, showCounts: false,
            countsPrefix: '',
            // Cut, a node with a copy answers reads from it: say so, and how fresh.
            stateLine: `proxy node → ${upstream} — remote unreachable${view.replica?.kept ? ` — reads served from its copy${view.replica.synced_at ? ` (as of ${view.replica.synced_at.slice(11, 16)} UTC)` : ''}` : ''}`,
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

/*
 * Taking the board over (become the master): on a proxy node only. The daemon
 * says through /api/node whether it may, and why not; the extension adds what
 * only it knows here: the URL where the master will reach this machine, read
 * from Tailscale. The gesture is `aiball master take`, run like the other
 * actions, after a confirmation that says what restarts.
 */
export const TAKE_LABEL = 'Take the board over (become the master)';

export function takeArgv(url) {
    return ['aiball', '--json', 'master', 'take', '--url', String(url), '--yes'];
}

/**
 * The menu entry. `view` is daemonView's result (with the node's `switch`),
 * `selfUrl` the tailnet URL this board is served on, or null.
 */
export function takeEntry(view, selfUrl) {
    if (!String(view?.state ?? '').startsWith('proxy'))
        return {visible: false, sensitive: false, label: TAKE_LABEL, reasons: [], url: null};
    const reasons = [];
    if (view.state === 'proxy-remote-down') reasons.push('the master is out of reach: it hands the board over itself');
    if (!view.switch) reasons.push('this daemon does not say whether it can take over (update it)');
    else reasons.push(...(view.switch.reasons ?? []));
    if (!selfUrl) reasons.push('no URL where the master reaches this machine: expose it on the tailnet');
    const sensitive = reasons.length === 0;
    return {
        visible: true,
        sensitive,
        label: sensitive ? TAKE_LABEL : `${TAKE_LABEL} — not now: ${reasons[0]}`,
        reasons,
        url: selfUrl ?? null,
    };
}

/** The confirmation, as the CLI asks it. */
export function takeConfirmation(upstream, url) {
    return {
        title: 'Take the board over?',
        body: `This machine becomes the master, and ${upstream ?? 'the current master'} its node, reaching it at ${url}.\n\n` +
            'The master stops taking writes while this machine catches up and checks its copy. ' +
            'Then both daemons restart, and every agent loop of both machines with them.',
        button: 'Take over and restart',
    };
}

/** What `aiball --json master take` answered, in one line for a notification. */
export function takeResult(text) {
    let r = null;
    try {
        r = JSON.parse(String(text ?? ''));
    } catch {
        // Not JSON: the CLI refused, and said why on its error output.
    }
    if (r && r.to) return `this machine is the master now (from ${r.from}, at revision ${r.last})${r.restarting ? '; both daemons restart' : ''}`;
    const said = String(text ?? '').trim().replace(/^aiball: /, '').replace(/^the switch did not happen: /, '');
    return `the switch did not happen${said ? `: ${said}` : ''}`;
}
