/**
 * #160 Phase 1 (david `f9agk3` + `8dpg24` plan) — upstream provider abstraction.
 *
 * Resolves textual refs like `gh#1160` or `gh:owner/repo#1160` to a clickable
 * URL using the project's per-binding `.aiball.yaml upstream:[]` config. Phase
 * 1 is pure rendering : no API calls, no webhooks, no sync. Just turn a textual
 * ref into a chip with a link.
 *
 * Providers are extensible (`UpstreamProvider`) so adding GitLab/Gitea later
 * = drop another implementation in the registry.
 */

/** Where the ref lives (provider-specific shape, kept extensible). */
export interface UpstreamTarget {
    owner: string;
    repo: string;
    /** Future providers may add `host` (Gitea/self-hosted GitLab), `group`, etc. */
}

/** A binding declared in `.aiball.yaml upstream:[]`. */
export interface UpstreamBinding {
    /** Provider id — matches `UpstreamProvider.id` (e.g. `"github"`). */
    kind: string;
    /** Reference string parsed per provider (e.g. `"github:owner/repo"`). */
    ref: string;
    /** When true, this binding resolves the bare `<prefix>#NNN` form. Only one
     *  default per (provider, prefix) — others must use the explicit form. */
    default?: boolean;
}

/** Resolved ref ready to render in HTML. */
export interface ResolvedRef {
    url: string;
    label: string;
    provider: string;
    target: UpstreamTarget;
    num: number;
}

/**
 * Phase 2 — a normalized external issue, provider-agnostic. The coupling
 * driver maps this onto an aiball ticket (title/body/state + labels→tags).
 */
export interface ExternalIssue {
    num: number;
    title: string;
    body: string;
    /** Coarse lifecycle state, normalized across providers. */
    state: "open" | "closed";
    /** Label names (github labels / gitlab labels) → aiball tags. */
    labels: string[];
    /** Canonical web URL of the issue. */
    url: string;
}

/** Options for a live fetch. `fetchImpl` is injectable for tests. */
export interface FetchIssueOpts {
    /** Bearer token for the provider's API (host-level credential). */
    token?: string | null;
    /** Override the global `fetch` (tests inject a stub). */
    fetchImpl?: typeof fetch;
}

/** Provider interface — each implementation owns its parse + URL build. */
export interface UpstreamProvider {
    /** Stable identifier — used in `.aiball.yaml upstream[].kind`. */
    id: string;
    /** Textual prefix for the bare form (e.g. `"gh"` → `gh#NNN`). */
    refPrefix: string;
    /** Parse a binding's `ref` string into a target. Returns null when the
     *  ref is malformed (caller skips this binding). */
    parseRef(ref: string): UpstreamTarget | null;
    /** Build the URL for a (target, num) pair. */
    buildUrl(target: UpstreamTarget, num: number): string;
    /**
     * Phase 2 — fetch a single external issue. OPTIONAL: render-only
     * providers (phase 1) omit it and stay valid; a provider without
     * `fetchIssue` simply can't be imported from. Throws on HTTP / network
     * error (caller surfaces the message).
     */
    fetchIssue?(target: UpstreamTarget, num: number, opts?: FetchIssueOpts): Promise<ExternalIssue>;
}

/** GitHub provider — phase 1's only implementation. Zero deps. */
export const githubProvider: UpstreamProvider = {
    id: "github",
    refPrefix: "gh",
    parseRef(ref: string): UpstreamTarget | null {
        // Expected: `github:owner/repo`
        const m = ref.match(/^github:([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})?)\/([a-zA-Z0-9._-]+)$/);
        if (!m) return null;
        return { owner: m[1], repo: m[2] };
    },
    buildUrl(target, num) {
        return `https://github.com/${target.owner}/${target.repo}/issues/${num}`;
    },
    async fetchIssue(target, num, opts = {}): Promise<ExternalIssue> {
        const doFetch = opts.fetchImpl ?? fetch;
        const url = `https://api.github.com/repos/${target.owner}/${target.repo}/issues/${num}`;
        const headers: Record<string, string> = {
            "accept": "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            // GitHub rejects requests without a User-Agent.
            "user-agent": "aiball-upstream-coupling",
        };
        if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
        const res = await doFetch(url, { headers });
        if (!res.ok) {
            const hint = res.status === 404
                ? " (not found — private repo needs a token, or wrong owner/repo/num)"
                : res.status === 401 || res.status === 403
                    ? " (auth — check the github token in ~/.config/aiball/config.yaml)"
                    : "";
            throw new Error(`github: GET ${target.owner}/${target.repo}#${num} → HTTP ${res.status}${hint}`);
        }
        const j = await res.json() as {
            number: number;
            title: string;
            body: string | null;
            state: string;
            html_url: string;
            labels?: Array<string | { name?: string }>;
            pull_request?: unknown;
        };
        // A PR is also an "issue" in GitHub's API; refuse to import one as a
        // ticket (its lifecycle is different). Explicit over silent.
        if (j.pull_request) {
            throw new Error(`github: ${target.owner}/${target.repo}#${num} is a pull request, not an issue`);
        }
        const labels = (j.labels ?? [])
            .map((l) => (typeof l === "string" ? l : l?.name))
            .filter((n): n is string => !!n);
        return {
            num: j.number,
            title: j.title,
            body: j.body ?? "",
            state: j.state === "closed" ? "closed" : "open",
            labels,
            url: j.html_url,
        };
    },
};

/** Built-in providers. Extend by appending here. */
export const BUILT_IN_PROVIDERS: UpstreamProvider[] = [githubProvider];

/** Look up a provider by its stable `id` (e.g. `"github"`). Null when unknown. */
export function providerByKind(
    kind: string,
    providers: readonly UpstreamProvider[] = BUILT_IN_PROVIDERS,
): UpstreamProvider | null {
    return providers.find((p) => p.id === kind) ?? null;
}

/**
 * Resolve a textual ref like `gh#1160` or `gh:owner/repo#1160` against the
 * project's bindings. Returns null when:
 *   - prefix doesn't match any registered provider, OR
 *   - bare form (`gh#NNN`) but no default binding for that provider in the
 *     project's upstream config, OR
 *   - explicit form (`gh:x/y#NNN`) but the `x/y` part doesn't parse for this
 *     provider's grammar.
 *
 * Caller (formatter) treats null as "leave as plain text" — graceful degrade.
 */
export function resolveProjectRef(
    raw: string,
    bindings: readonly UpstreamBinding[],
    providers: readonly UpstreamProvider[] = BUILT_IN_PROVIDERS,
): ResolvedRef | null {
    // Match `<prefix>#NNN` or `<prefix>:owner/repo#NNN`.
    // The regex captures: 1=prefix, 2=optional `owner/repo` (with `:` removed
    // by the inner group), 3=numeric id.
    const m = raw.match(/^([a-z][a-z0-9]*)(?::([^\s#]+))?#(\d+)$/i);
    if (!m) return null;
    const [, prefix, explicit, numStr] = m;
    const num = Number(numStr);
    if (!Number.isFinite(num) || num <= 0) return null;
    const provider = providers.find((p) => p.refPrefix === prefix.toLowerCase());
    if (!provider) return null;
    let target: UpstreamTarget | null = null;
    if (explicit) {
        // Explicit `<prefix>:<refTail>#NNN` form — synthesize a binding ref so
        // the provider's parser does the validation (keeps the format
        // authority in one place per provider).
        target = provider.parseRef(`${provider.id}:${explicit}`);
        if (!target) return null;
    } else {
        // Bare form — find the default binding for this provider.
        const def = bindings.find((b) => b.kind === provider.id && b.default);
        if (!def) return null;
        target = provider.parseRef(def.ref);
        if (!target) return null;
    }
    return {
        url: provider.buildUrl(target, num),
        label: raw, // keep author's exact spelling (canonical form)
        provider: provider.id,
        target,
        num,
    };
}
