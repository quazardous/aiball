/**
 * #1563 — the wire, separated from the GitHub semantics.
 *
 * `upstream-providers.ts` used to own both: what a GitHub issue *is* (URL
 * shapes, PR-vs-issue, label mapping) AND how bytes get there (`fetch`,
 * headers, Bearer). This module takes the second half.
 *
 * The provider now speaks only in **paths** (`repos/{owner}/{repo}/issues/12`)
 * and a transport carries them. Two exist:
 *
 *   - `httpTransport` — `fetch` against api.github.com, with a token.
 *   - `ghTransport`   — `gh api`, which speaks the *same REST paths* and
 *     borrows the CLI's keyring credential. That's the point: no second
 *     credential to manage (david, #1562).
 *
 * `gh api` and not `gh issue`: the subcommands would force the provider to
 * learn a second vocabulary, while `gh api repos/o/r/issues/12` returns byte
 * for byte what the HTTP path returns. Verified against a live issue.
 *
 * **Transports are per-provider.** `gh` only speaks GitHub; a future GitLab
 * provider would bring its own pair (http + `glab`). The interface is generic,
 * the instances are not.
 *
 * ## Failure is the point
 *
 * A transport NEVER throws on an HTTP status — it returns `{status, json}` so
 * the provider's existing hints ("404 → private repo needs a token", "401/403
 * → check the token") stay true whichever wire was used. It throws only when
 * the wire itself broke, and then the message names the transport: with two
 * transports in play, "github: failed" no longer says anything.
 *
 * And no silent fallback. Selection may be dynamic, execution is not: once a
 * transport is chosen its failure surfaces as-is. A `gh` that quietly retried
 * over HTTP would hide a broken `gh` for weeks — the opposite of what this
 * ticket is for.
 */
import { spawn } from "node:child_process";

export interface TransportProbe {
    /** Usable right now — binary present, authenticated, credential resolved. */
    ok: boolean;
    /** Human-readable state, shown by diagnostics. Always set, ok or not. */
    detail: string;
}

export interface TransportResponse {
    /** HTTP status. 0 when the wire broke before getting one. */
    status: number;
    /** Parsed body, or null when there wasn't one / it wasn't JSON. */
    json: unknown;
}

export interface UpstreamTransport {
    readonly id: "http" | "gh";
    probe(): Promise<TransportProbe>;
    /** `path` is REST-relative (`repos/o/r/issues/12`) — no leading slash,
     *  no host. Resolves with the status even on 4xx/5xx; rejects only when
     *  the wire itself failed. */
    request(path: string, init?: { method?: string; body?: unknown }): Promise<TransportResponse>;
}

// ---------------------------------------------------------------------------
// http — the pre-existing path, unchanged in behaviour.
// ---------------------------------------------------------------------------

const GH_API = "https://api.github.com";

export function httpTransport(opts: {
    token?: string | null;
    fetchImpl?: typeof fetch;
} = {}): UpstreamTransport {
    const doFetch = opts.fetchImpl ?? fetch;
    return {
        id: "http",
        async probe(): Promise<TransportProbe> {
            // Always usable: public repos import unauthenticated. The token
            // only widens what's reachable, so its absence is reported, not
            // treated as a failure.
            return opts.token
                ? { ok: true, detail: "http: token configured" }
                : { ok: true, detail: "http: no token — public repos only, lower rate limit" };
        },
        async request(path, init = {}): Promise<TransportResponse> {
            const headers: Record<string, string> = {
                "accept": "application/vnd.github+json",
                "x-github-api-version": "2022-11-28",
                // GitHub rejects requests without a User-Agent.
                "user-agent": "aiball-upstream-coupling",
            };
            if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
            if (init.body !== undefined) headers["content-type"] = "application/json";
            let res: Response;
            try {
                res = await doFetch(`${GH_API}/${path}`, {
                    method: init.method ?? "GET",
                    headers,
                    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
                });
            } catch (e) {
                throw new Error(`http: ${(e as Error).message}`);
            }
            let json: unknown = null;
            try { json = await res.json(); } catch { /* empty or non-JSON body */ }
            return { status: res.status, json };
        },
    };
}

// ---------------------------------------------------------------------------
// gh — the CLI, borrowing its own credential.
// ---------------------------------------------------------------------------

interface Ran { code: number; stdout: string; stderr: string }

/**
 * Hard ceiling on any `gh` invocation.
 *
 * A subprocess that never exits — a credential helper waiting on a prompt, a
 * hung TLS connect — would otherwise leave a promise pending forever. That was
 * survivable while every call was a human typing `ticket import`; it stops
 * being survivable the moment a scheduled poller chains them, because the
 * scheduler's overlap guard would then skip every subsequent tick, silently,
 * for as long as the process hangs.
 */
export const GH_TIMEOUT_MS = 20_000;

/** Exported so the timeout can be tested against a real hanging child rather
 *  than a stub — `runImpl` replaces this function wholesale, so injecting a
 *  stub would test everything except the guard that matters. */
export function runCommand(cmd: string, args: string[], stdin?: string, timeoutMs = GH_TIMEOUT_MS): Promise<Ran> {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
        } catch (e) {
            reject(new Error(`gh: cannot spawn ${cmd} — ${(e as Error).message}`));
            return;
        }
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
        const timer = setTimeout(() => {
            // SIGTERM first; a `gh` wedged on a credential prompt ignores it,
            // so escalate. Both are best-effort — the promise rejects either way
            // rather than staying pending, which is the whole point.
            child.kill("SIGTERM");
            setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 2_000).unref();
            finish(() => reject(new Error(`gh: timed out after ${timeoutMs}ms (killed)`)));
        }, timeoutMs);
        timer.unref();
        child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        child.on("error", (e) => finish(() => reject(new Error(`gh: ${e.message}`))));
        child.on("close", (code) => finish(() => resolve({ code: code ?? -1, stdout, stderr })));
        if (stdin !== undefined) child.stdin.end(stdin);
        else child.stdin.end();
    });
}

/**
 * PURE — pull the HTTP status out of what `gh api` leaves behind.
 *
 * On a 404 `gh` exits 1, prints GitHub's error JSON on **stdout**
 * (`{"message":"Not Found","status":"404"}`) and a prose line on stderr
 * (`gh: Not Found (HTTP 404)`). stdout is the reliable source; stderr is the
 * fallback for the cases where there's no JSON at all.
 *
 * Note `status` arrives as a **string** in GitHub's error JSON. Comparing it
 * to a number would fail silently, and only ever in the failure path — i.e.
 * exactly when the diagnosis is needed.
 */
export function ghStatusFrom(stdout: string, stderr: string): { status: number; json: unknown } {
    let json: unknown = null;
    try { json = JSON.parse(stdout); } catch { /* not JSON */ }
    if (json && typeof json === "object" && "status" in json) {
        const raw = (json as { status: unknown }).status;
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return { status: n, json };
    }
    const m = stderr.match(/\(HTTP (\d{3})\)/);
    if (m) return { status: Number(m[1]), json };
    return { status: 0, json };
}

export function ghTransport(opts: { runImpl?: typeof runCommand } = {}): UpstreamTransport {
    const exec = opts.runImpl ?? runCommand;
    return {
        id: "gh",
        async probe(): Promise<TransportProbe> {
            let version: Ran;
            try {
                version = await exec("gh", ["--version"]);
            } catch {
                return { ok: false, detail: "gh: not installed (or not on PATH)" };
            }
            if (version.code !== 0) return { ok: false, detail: "gh: not installed (or not on PATH)" };
            const auth = await exec("gh", ["auth", "status"]);
            if (auth.code !== 0) {
                return { ok: false, detail: "gh: installed but not authenticated — run `gh auth login`" };
            }
            const who = (auth.stdout + auth.stderr).match(/account (\S+)/);
            return { ok: true, detail: `gh: authenticated${who ? ` as ${who[1]}` : ""}` };
        },
        async request(path, init = {}): Promise<TransportResponse> {
            const args = ["api", path];
            if (init.method && init.method !== "GET") args.push("-X", init.method);
            // `--input -` makes gh read the JSON body from stdin, so we never
            // have to shell-quote user content.
            const stdin = init.body !== undefined ? JSON.stringify(init.body) : undefined;
            if (stdin !== undefined) args.push("--input", "-");
            const r = await exec("gh", args, stdin);
            if (r.code === 0) {
                let json: unknown = null;
                try { json = JSON.parse(r.stdout); } catch { /* empty body */ }
                return { status: 200, json };
            }
            const { status, json } = ghStatusFrom(r.stdout, r.stderr);
            if (status === 0) {
                // No status anywhere: the CLI itself failed (not authenticated,
                // network down, gh vanished). That's a wire break, not an HTTP
                // answer — and the message names the transport.
                throw new Error(`gh: ${r.stderr.trim() || `exited ${r.code}`}`);
            }
            return { status, json };
        },
    };
}
