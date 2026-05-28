/**
 * #160 Phase 1 — mirror of backend `src/upstream-providers.ts` for the
 * frontend resolver. Pure function : turns a textual ref like `gh#1160`
 * (in a body) into a resolved URL using the project's upstream bindings.
 *
 * Kept tiny + duplicated rather than importing across the front/back
 * boundary — same shape, easier to evolve independently.
 */

export interface UpstreamTarget {
    owner: string;
    repo: string;
}

export interface UpstreamBinding {
    kind: string;
    ref: string;
    default?: boolean;
}

export interface ResolvedRef {
    url: string;
    label: string;
    provider: string;
    target: UpstreamTarget;
    num: number;
}

export interface UpstreamProvider {
    id: string;
    refPrefix: string;
    parseRef(ref: string): UpstreamTarget | null;
    buildUrl(target: UpstreamTarget, num: number): string;
}

export const githubProvider: UpstreamProvider = {
    id: "github",
    refPrefix: "gh",
    parseRef(ref: string): UpstreamTarget | null {
        const m = ref.match(/^github:([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})?)\/([a-zA-Z0-9._-]+)$/);
        if (!m) return null;
        return { owner: m[1], repo: m[2] };
    },
    buildUrl(target, num) {
        return `https://github.com/${target.owner}/${target.repo}/issues/${num}`;
    },
};

export const BUILT_IN_PROVIDERS: UpstreamProvider[] = [githubProvider];

export function resolveProjectRef(
    raw: string,
    bindings: readonly UpstreamBinding[],
    providers: readonly UpstreamProvider[] = BUILT_IN_PROVIDERS,
): ResolvedRef | null {
    const m = raw.match(/^([a-z][a-z0-9]*)(?::([^\s#]+))?#(\d+)$/i);
    if (!m) return null;
    const [, prefix, explicit, numStr] = m;
    const num = Number(numStr);
    if (!Number.isFinite(num) || num <= 0) return null;
    const provider = providers.find((p) => p.refPrefix === prefix.toLowerCase());
    if (!provider) return null;
    let target: UpstreamTarget | null = null;
    if (explicit) {
        target = provider.parseRef(`${provider.id}:${explicit}`);
        if (!target) return null;
    } else {
        const def = bindings.find((b) => b.kind === provider.id && b.default);
        if (!def) return null;
        target = provider.parseRef(def.ref);
        if (!target) return null;
    }
    return {
        url: provider.buildUrl(target, num),
        label: raw,
        provider: provider.id,
        target,
        num,
    };
}

/**
 * HTML post-pass : scan `html` for `gh#NNN` style refs, replace each with an
 * `<a>` chip when resolvable, leave as plain text otherwise (graceful degrade).
 *
 * Skips text already inside <a>, <code>, <pre> to avoid mangling URLs or
 * inserting links inside code blocks.
 */
export function applyUpstreamRefs(
    html: string,
    projectName: string | null,
    upstream: Record<string, UpstreamBinding[]>,
    providers: readonly UpstreamProvider[] = BUILT_IN_PROVIDERS,
): string {
    if (!projectName) return html;
    const bindings = upstream[projectName];
    if (!bindings || bindings.length === 0) return html;
    // Match any registered provider prefix followed by optional `:owner/repo`
    // and `#NNN`. Skip when preceded by word char (avoid `foogh#1` matches).
    const prefixAlt = providers.map((p) => p.refPrefix).join("|");
    const re = new RegExp(`(?<![\\w@])(${prefixAlt})(?::([^\\s#<>"']+))?#(\\d+)\\b`, "gi");
    // We replace token-by-token but skip occurrences inside <a>...</a>,
    // <code>...</code>, <pre>...</pre>. Cheapest correct: split the html on
    // these blocks, only run the regex on the OUTSIDE chunks.
    const blockSplit = html.split(/(<a\b[^>]*>.*?<\/a>|<code\b[^>]*>.*?<\/code>|<pre\b[^>]*>[\s\S]*?<\/pre>)/g);
    const out: string[] = [];
    for (const chunk of blockSplit) {
        if (!chunk) continue;
        if (chunk.startsWith("<a") || chunk.startsWith("<code") || chunk.startsWith("<pre")) {
            out.push(chunk);
            continue;
        }
        out.push(chunk.replace(re, (raw) => {
            const r = resolveProjectRef(raw, bindings, providers);
            if (!r) return raw;
            // esc the url + label (raw is provider-prefix + digits + maybe owner/repo —
            // safe charset, but defensive).
            const esc = (s: string): string => s.replace(/[&<>"']/g, (c) =>
                ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
            return `<a href="${esc(r.url)}" class="upstream-ref upstream-ref--${esc(r.provider)}" target="_blank" rel="noopener noreferrer">${esc(r.label)}</a>`;
        }));
    }
    return out.join("");
}
