/**
 * #555 — strip markdown helper pour injecter un extrait de body de commentaire
 * dans le wake-phrase claude. David `r4eh53` "y a pas des bibliothèque pour
 * faire ça ?" + `gaqgpj` "ok option2" → strip via `marked` (déjà-dep frontend,
 * ajouté côté root pour ce usage) plutôt que regex maison ou une nouvelle dep
 * type `remove-markdown`.
 *
 * Stratégie : marked.parse(src) → strip HTML tags → entity decode → truncate.
 * marked gère correctement fenced code (qu'on aplatit à du texte), listes,
 * links, images, blockquotes — bien mieux qu'une regex naïve `s/[*_#`]+//g`.
 *
 * Le résultat est UN ONE-LINER prefix-stripable : on flatten tous les
 * whitespace runs en single-space (newlines compris). C'est ce qu'on veut
 * pour un wake-phrase : claude voit l'extrait comme une phrase, pas comme
 * un paragraphe formaté.
 */
import { marked } from "marked";

/** HTML entity decoder minimaliste — couvre les entities que marked émet
 *  (amp, lt, gt, quot, #39 + numeric refs). Évite d'importer un module
 *  HTML-entities additionnel pour 5 cas. */
function decodeEntities(s: string): string {
    return s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/**
 * Strip markdown formatting → texte brut single-line truncé. Garanti ne
 * jamais renvoyer plus de `maxLen` caractères (ellipse incluse) ; renvoie
 * une string vide pour les inputs vides ou whitespace-only.
 *
 *   stripMarkdown("**hello** [world](url)") → "hello world"
 *   stripMarkdown("```ts\nconst x = 1;\n```") → "const x = 1;"
 *   stripMarkdown("# Title\n\n- item 1\n- item 2") → "Title item 1 item 2"
 *   stripMarkdown("very long body…", 10) → "very long…"
 */
export function stripMarkdown(src: string, maxLen = 240): string {
    if (!src || !src.trim()) return "";
    let html: string;
    try {
        // gfm + breaks pour que marked traite \n raisonnablement ; sync
        // (async: false) car on est dans du code claude-loop côté backend
        // qui doit rester synchrone-friendly.
        html = marked.parse(src, { gfm: true, breaks: true, async: false }) as string;
    } catch {
        // Si marked plante (input weird), on retombe sur le src brut →
        // mieux vaut un wake avec du markdown que pas de wake.
        html = src;
    }
    // Strip HTML tags. marked émet du HTML well-formed, regex suffit.
    const noTags = html.replace(/<[^>]+>/g, " ");
    // Decode entities + collapse whitespace runs.
    const flat = decodeEntities(noTags).replace(/\s+/g, " ").trim();
    if (flat.length <= maxLen) return flat;
    // Truncate avec ellipse `…` (1 char). Coupe propre sur le dernier
    // word-boundary avant maxLen-1 pour ne pas tronquer au milieu d'un mot.
    const head = flat.slice(0, maxLen - 1);
    const lastSpace = head.lastIndexOf(" ");
    const cut = lastSpace > maxLen * 0.6 ? head.slice(0, lastSpace) : head;
    return cut.trimEnd() + "…";
}
