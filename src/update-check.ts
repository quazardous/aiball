/**
 * #2586 — which aiball is running, which is installed, and whether a newer
 * release exists.
 *
 * One check, in the daemon, that the Windows tray, the GNOME extension and the
 * CLI all read: none of them goes to the network on its own, and the extension
 * keeps talking to the socket only. The check runs when the daemon starts, and
 * again on demand ("Check for updates"). `updates.check: false` in the global
 * config turns every outbound call off.
 *
 * Three versions, three different fixes:
 *   - `running`   — what the daemon booted with;
 *   - `installed` — `package.json` on disk now. Differs from `running` when code
 *                   landed and the daemon was not restarted: restart, not update;
 *   - `latest`    — the latest GitHub Release. Newer than `installed`: update.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASES_LATEST_URL = "https://api.github.com/repos/quazardous/aiball/releases/latest";
/** An on-demand check within this long of the last one answers the cache. */
export const CHECK_MIN_INTERVAL_MS = 60_000;

/** `1.2.3` or `v1.2.3` → [1,2,3]; anything else (pre-releases included) → null. */
export function parseVersion(raw: string | null | undefined): [number, number, number] | null {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(raw ?? "").trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 / 0 / 1, or null when either side is not a plain x.y.z. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 | null {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa || !pb) return null;
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    }
    return 0;
}

export interface LatestRelease {
    version: string;
    url: string | null;
}

/** The GitHub `releases/latest` body → its version and page, or null. */
export function latestFromRelease(body: unknown): LatestRelease | null {
    const b = body as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown } | null;
    if (!b || typeof b.tag_name !== "string" || b.draft === true || b.prerelease === true) return null;
    const parsed = parseVersion(b.tag_name);
    if (!parsed) return null;
    return { version: parsed.join("."), url: typeof b.html_url === "string" ? b.html_url : null };
}

export interface UpdateCheckState {
    latest: string | null;
    release_url: string | null;
    checked_at: string | null;
    error: string | null;
}

export interface VersionView extends UpdateCheckState {
    running: string;
    installed: string;
    /** `latest` is newer than `installed`. */
    update_available: boolean;
    /** `installed` differs from `running`: the daemon was not restarted. */
    restart_needed: boolean;
    /** The check is turned off (`updates.check: false`). */
    check_disabled: boolean;
}

/** Pure: the view every client renders. */
export function versionView(running: string, installed: string, state: UpdateCheckState, checkDisabled: boolean): VersionView {
    return {
        running,
        installed,
        ...state,
        update_available: compareVersions(state.latest, installed) === 1,
        restart_needed: compareVersions(installed, running) !== 0 && parseVersion(installed) !== null,
        check_disabled: checkDisabled,
    };
}

/** `package.json` as it is on disk NOW — not the version the process loaded. */
export function readInstalledVersion(root: string = join(dirname(fileURLToPath(import.meta.url)), "..")): string {
    try {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
        return typeof pkg.version === "string" ? pkg.version : "0.0.0";
    } catch {
        return "0.0.0";
    }
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
}>;

let state: UpdateCheckState = { latest: null, release_url: null, checked_at: null, error: null };
let inFlight: Promise<UpdateCheckState> | null = null;
let lastRunMs = 0;

export function updateCheckState(): UpdateCheckState {
    return { ...state };
}

/**
 * Ask GitHub for the latest release. One call at a time; within
 * `CHECK_MIN_INTERVAL_MS` of the last one, the cached answer is returned. A
 * failure is recorded, never thrown: an offline machine is a normal machine.
 */
export function runUpdateCheck(fetchImpl: FetchLike, nowMs = Date.now()): Promise<UpdateCheckState> {
    if (inFlight) return inFlight;
    if (lastRunMs && nowMs - lastRunMs < CHECK_MIN_INTERVAL_MS) return Promise.resolve(updateCheckState());
    lastRunMs = nowMs;
    inFlight = (async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        try {
            const res = await fetchImpl(RELEASES_LATEST_URL, {
                headers: { accept: "application/vnd.github+json", "user-agent": "aiball-update-check" },
                signal: ctrl.signal,
            });
            if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
            const latest = latestFromRelease(await res.json());
            if (!latest) throw new Error("the latest release has no x.y.z tag");
            state = { latest: latest.version, release_url: latest.url, checked_at: new Date(nowMs).toISOString(), error: null };
        } catch (e) {
            state = { ...state, checked_at: new Date(nowMs).toISOString(), error: (e as Error).message };
        } finally {
            clearTimeout(timer);
            inFlight = null;
        }
        return updateCheckState();
    })();
    return inFlight;
}

/** Tests only. */
export function resetUpdateCheckForTest(): void {
    state = { latest: null, release_url: null, checked_at: null, error: null };
    inFlight = null;
    lastRunMs = 0;
}
