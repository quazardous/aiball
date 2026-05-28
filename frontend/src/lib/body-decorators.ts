/**
 * #160 Commit B — body-text decorator registry.
 *
 * Centralise les enrichissements appliqués au markdown des bodies (commentaires,
 * descriptions de tickets, etc.) derrière une interface uniforme. David
 * `6nyfdk` : « il faut une sorte de mini register de decorateur » — un
 * register-style array d'entrées plug-and-play, plutôt que chaque feature qui
 * câble son passe ad-hoc dans `MarkdownView.vue`.
 *
 * Le pipeline complet, par ordre :
 *
 *     rawSrc
 *       → preMarked*    (chaque décorateur peut substituer dans la source)
 *       → marked.parse  (instance partagée, exts inline data-driven)
 *       → DOMPurify     (sanitize unique, central ici)
 *       → postSanitize* (chaque décorateur peut scanner/réécrire le HTML)
 *       → restore*      (re-injection des placeholders posés en preMarked)
 *
 * Chaque hook est optionnel. Un décorateur peut être purement preMarked
 * (upstream chips), purement postSanitize (les mention spans / refs en
 * codespan), ou les deux si besoin.
 *
 * Les phases preMarked et postSanitize itèrent **dans l'ordre du registry**.
 * Le restore tourne dans **l'ordre inverse de la pose** (les restores empilés
 * en preMarked se dépilent en fin de pipeline) — ça reproduit le LIFO naturel
 * d'un système de placeholders : le dernier qui pose est le premier à
 * restorer, pour ne jamais déplier dans le mauvais HTML.
 *
 * Pourquoi distinguer postSanitize et restore alors qu'on pourrait tout
 * traiter en postSanitize : l'`<a>` injecté en restore garde ses attrs
 * `target="_blank"` + `rel="noopener noreferrer"` car DOMPurify a déjà tourné
 * — `ALLOWED_ATTR` n'inclut PAS `target`/`rel`, donc tout `<a>` posé AVANT
 * sanitize perdrait ces attrs. Garder restore après sanitize est le seul
 * moyen de préserver `target="_blank"` sans élargir l'ALLOWED_ATTR (qui
 * exposerait toute la page utilisateur à du `target`/`rel` arbitraire).
 */
import DOMPurify from "dompurify";
import { patternsDecorator } from "./formatting";
import { upstreamDecorator } from "./upstream-providers";

/**
 * Minimal structural type pour le moteur markdown qu'on consomme. On évite
 * d'importer `Marked` du package directement : le type publié par `marked`
 * embarque pas mal de generics + des overloads, et l'instance qu'on lui
 * passe en pratique (un `Marked` construit dans `formatting.ts`) n'est pas
 * toujours assignable à ce générique sous vue-tsc. Structural est OK : on
 * n'appelle que `.parse(src, {async:false})`.
 */
export interface MarkdownEngine {
    parse(src: string, opts?: { async?: false }): string;
}

export interface BodyDecoratorContext {
    /** Project this body lives under (used by upstream provider resolution). */
    project: string | null;
}

export interface BodyDecorator {
    /** Stable id — utile pour debug + un éventuel override `enabled`. */
    id: string;
    /**
     * Substitution avant marked. Retourne la nouvelle source + un restore
     * appliqué en fin de pipeline (après sanitize) pour ré-injecter le
     * contenu décoré à la place des placeholders posés. Le restore est
     * optionnel : un décorateur peut simplement re-écrire la source si la
     * substitution survit déjà à marked + sanitize.
     */
    preMarked?(
        src: string,
        ctx: BodyDecoratorContext,
    ): { src: string; restore?: (html: string) => string };
    /**
     * Pass post-sanitize sur le HTML final. Reçoit le HTML déjà passé par
     * marked + DOMPurify (donc tout `<a>` injecté ici est limité aux
     * `ALLOWED_ATTR` puisque sanitize ne re-tourne pas).
     */
    postSanitize?(html: string, ctx: BodyDecoratorContext): string;
}

/**
 * Liste blanche DOMPurify partagée par tous les bodies aiball. Tirée
 * verbatim de la config historique de `MarkdownView.vue` — centralisée ici
 * pour qu'un nouveau décorateur sache exactement ce qui survit au sanitize
 * (et donc quelles attrs il PEUT poser pre-sanitize vs lesquelles imposent
 * un restore post-sanitize).
 */
const SANITIZE_CONFIG = {
    ALLOWED_TAGS: [
        "h1", "h2", "h3", "h4", "h5", "h6",
        "p", "br", "hr",
        "strong", "em", "del", "code", "pre",
        "span",
        "blockquote",
        "ul", "ol", "li",
        "a", "img",
        "table", "thead", "tbody", "tr", "th", "td",
        "input",
    ],
    ALLOWED_ATTR: ["href", "title", "alt", "src", "type", "checked", "disabled", "class"],
    ALLOW_DATA_ATTR: false,
};

/**
 * Exécute le pipeline complet. Pure : pas de globals, pas de side-effects.
 * Les inputs (marked instance, décorateurs) sont passés par le caller (qui
 * dans le cas de Vue lit les refs réactives — `markedInstance.value`,
 * `BUILT_IN_BODY_DECORATORS`).
 *
 * Sanitize est invoqué EXACTEMENT UNE FOIS — ne pas re-sanitize après les
 * restores (un sanitize round-trip stripperait les `target`/`rel` que la
 * phase restore vient de poser).
 */
export function renderBody(
    rawSrc: string,
    marked: MarkdownEngine,
    ctx: BodyDecoratorContext,
    decorators: readonly BodyDecorator[],
): string {
    if (!rawSrc) return "";

    // preMarked pass — collecte les restores au passage (LIFO).
    let src = rawSrc;
    const restores: Array<(html: string) => string> = [];
    for (const d of decorators) {
        if (!d.preMarked) continue;
        const r = d.preMarked(src, ctx);
        src = r.src;
        if (r.restore) restores.unshift(r.restore);
    }

    // marked → sanitize (unique).
    const raw = marked.parse(src, { async: false }) as string;
    let html = DOMPurify.sanitize(raw, SANITIZE_CONFIG) as unknown as string;

    // postSanitize pass.
    for (const d of decorators) {
        if (!d.postSanitize) continue;
        html = d.postSanitize(html, ctx);
    }

    // restore pass (LIFO).
    for (const restore of restores) {
        html = restore(html);
    }
    return html;
}

/**
 * Registry shipped : ordre = ordre d'application dans le pipeline.
 *
 *  - `upstreamDecorator`  : preMarked (substitue `gh#NNN` par des
 *                           placeholders avant marked) + restore.
 *  - `patternsDecorator`  : postSanitize (wrap `@mention` en span, et
 *                           re-linkifie les refs en codespan).
 *
 * Pour ajouter un nouveau décorateur (ex. emoji-shortcodes, mathjax, etc.),
 * importer son `BodyDecorator` ici et l'ajouter au tableau au bon endroit.
 */
export const BUILT_IN_BODY_DECORATORS: readonly BodyDecorator[] = [
    upstreamDecorator,
    patternsDecorator,
];
