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
 * #160 Commit A — pre-marked placeholder approach (david `6nyfdk`/`n3e99g`
 * "go refactor, soit futur proof"). Au lieu de scanner le HTML rendu post-
 * sanitize (qui force des lookbehinds hacks sur le ticket pattern), on
 * substitue les `gh#NNN` par des placeholders Unicode AVANT marked. Marked
 * voit du texte opaque, sa grammar (incl. ticket inline ext) ne matche pas
 * dessus. Après sanitize, on re-injecte les `<a>` chips à la place des
 * placeholders.
 *
 * Avantages :
 * - Plus de conflit avec le ticket regex (revert le lookbehind hack).
 * - Symétrique pour ajout de gl/gt/futur providers.
 * - Placeholder = U+E000 (private use area) → marked le voit comme texte,
 *   pas de risque de collision avec user content.
 * - `<a>` injecté POST-sanitize → target/rel survivent (sinon DOMPurify les
 *   stripperait, l'ALLOWED_ATTR ne les inclut pas).
 */
const PH_START = "";
const PH_END = "";

function escHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function buildUpstreamRegex(providers: readonly UpstreamProvider[]): RegExp {
    const prefixAlt = providers.map((p) => p.refPrefix).join("|");
    // Précédé par non-word (évite `foogh#1`) ; capture le prefixe + optional
    // `:owner/repo` + `#NNN`.
    return new RegExp(`(?<![\\w@])(${prefixAlt})(?::([^\\s#<>"']+))?#(\\d+)\\b`, "gi");
}

/**
 * Pre-marked pass : substitue `gh#NNN` (et autres provider prefixes) par des
 * placeholders Unicode. Retourne `{src: modified, restore: html→html}`. Le
 * `restore` re-injecte les `<a>` chips à la place des placeholders dans le
 * HTML sanitized.
 *
 * Si pas de project ou pas de bindings : `src` inchangée, `restore` no-op
 * (graceful : la ref reste en texte plain dans le rendu final, identique au
 * comportement pré-refactor).
 */
export function decorateUpstreamPreMarked(
    src: string,
    projectName: string | null,
    upstream: Record<string, UpstreamBinding[]>,
    providers: readonly UpstreamProvider[] = BUILT_IN_PROVIDERS,
): { src: string; restore: (html: string) => string } {
    if (!projectName) return { src, restore: (h) => h };
    const bindings = upstream[projectName];
    if (!bindings || bindings.length === 0) return { src, restore: (h) => h };
    const re = buildUpstreamRegex(providers);
    const replacements = new Map<string, string>();
    let idx = 0;
    const newSrc = src.replace(re, (raw) => {
        const r = resolveProjectRef(raw, bindings, providers);
        if (!r) return raw;
        const placeholder = `${PH_START}UP${idx++}${PH_END}`;
        replacements.set(
            placeholder,
            `<a href="${escHtml(r.url)}" class="upstream-ref upstream-ref--${escHtml(r.provider)}" target="_blank" rel="noopener noreferrer">${escHtml(r.label)}</a>`,
        );
        return placeholder;
    });
    if (replacements.size === 0) return { src, restore: (h) => h };
    return {
        src: newSrc,
        restore(html: string): string {
            let out = html;
            for (const [ph, replacement] of replacements) {
                out = out.split(ph).join(replacement);
            }
            return out;
        },
    };
}
