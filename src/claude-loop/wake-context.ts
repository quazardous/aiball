/**
 * #1098 — wake context resolution, extracted from kernel.ts so it's unit
 * testable (kernel.ts runs `main()` at import time). The client is injected
 * (same convention as `buildContextPhrase`).
 *
 * #544 + #555 — one-shot fetch qui sert à la fois (a) le filtre stakeholder
 * et (b) l'extraction du body du commentaire pour l'inject dans le wake.
 *
 * **Stakeholder** = true iff l'un de :
 *   - l'agent tient un claim live sur le ticket
 *   - l'agent est l'assignee explicite
 *   - le body du commentaire @-mentionne l'agent
 *
 * Reporter (`by_agent`) seul N'est PAS suffisant (david `hdc7hn` :
 * « aiball-win est le reporter/owner mais il doit pas le claim »).
 *
 * **commentBody** = extrait markdown-strippé via `stripMarkdown`, renseigné
 * dès que le hint porte un `comment_id` (le message exact est refetché par
 * id) — indépendamment du verdict stakeholder (le caller décide s'il l'utilise).
 *
 * #1098 — le body DOIT être pivot-immune. Avant, on le tirait d'une lecture
 * `brief` du ticket + find-by-hashid, mais `brief` est pivot-cut (lossy) : un
 * `summary_until` qui arrive entre le ping et la livraison (différée) du wake
 * fait passer le commentaire humain SOUS le pivot → body vide → wake = refs
 * nues `(#T / #hashid)`. On refetch donc le message exact par id
 * (`GET /api/messages/:id` renvoie la ligne complète, sans snapshot) et on
 * réserve la lecture ticket `summary` (cheap, header-only) au seul verdict
 * stakeholder. Fallback brief-by-hashid uniquement quand le hint ne porte pas
 * de `comment_id` (vieux daemon / ping ticket-only) — pas de régression.
 *
 * Fail-open sur stakeholder : si la lookup foire (daemon down, id manquant,
 * timeout), on suppose stakeholder=true → mieux vaut un wake gratuit qu'un
 * miss silencieux. commentBody reste vide dans ce cas.
 */
import type { AiballClient } from "../client.js";
import { stripMarkdown } from "./markdown-strip.js";
import type { WakeHint } from "./state.js";

export async function fetchWakeContext(
    client: AiballClient,
    hint: WakeHint,
    me: string | undefined,
): Promise<{ stakeholder: boolean; commentBody?: string; commentKind?: string }> {
    if (!me || !hint.ticket_id) return { stakeholder: true };
    try {
        // Ticket header (claimant/assignee) + le message déclencheur par id,
        // en parallèle. getMessage est best-effort (null si échec) ; le verdict
        // stakeholder ne dépend pas du body.
        const [tResp, mResp] = await Promise.all([
            client.getTicket(hint.ticket_id, { summary: true }) as Promise<{
                ticket?: { claimant?: string | null; assignee?: string | null };
            }>,
            hint.comment_id
                ? (client.getMessage(hint.comment_id) as Promise<{ body?: string | null; kind?: string }>)
                    .catch(() => null)
                : Promise.resolve(null),
        ]);
        const t = tResp.ticket;
        if (!t) return { stakeholder: true };
        // Body source: le message refetché par id (pivot-immune). Fallback sur
        // le find-by-hashid en brief SEULEMENT si le hint n'a pas de comment_id.
        let rawBody = mResp?.body ?? "";
        if (!rawBody && !hint.comment_id && hint.comment_hashid) {
            const brief = await (client.getTicket(hint.ticket_id, { brief: true }) as Promise<{
                comments?: Array<{ hashid?: string; body?: string | null }>;
            }>).catch(() => ({ comments: [] as Array<{ hashid?: string; body?: string | null }> }));
            const cm = Array.isArray(brief.comments)
                ? brief.comments.find((x) => x.hashid === hint.comment_hashid)
                : undefined;
            rawBody = cm?.body ?? "";
        }
        // Extraire body avant le verdict pour que l'enrichment marche aussi
        // sur le chemin claim/assignee (sans @-mention dans le body).
        let commentBody: string | undefined;
        let mentionsMe = false;
        if (rawBody) {
            commentBody = stripMarkdown(rawBody);
            // Same lookbehind shape as the formatting mention regex (#535),
            // minus `>` to also catch mentions au start de markdown paragraphs.
            const escaped = me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = new RegExp(`(?<![\\w@"'/])@${escaped}\\b`);
            mentionsMe = re.test(rawBody);
        }
        const stakeholder = t.claimant === me || t.assignee === me || mentionsMe;
        // #1169 — remonter le kind du message déclencheur : la branche
        // comment-centrique du wake ne doit PAS s'appliquer à un decision-event
        // (body vide par nature) sinon le wake se réduit aux refs nues.
        return { stakeholder, commentBody, commentKind: mResp?.kind };
    } catch {
        return { stakeholder: true };
    }
}
