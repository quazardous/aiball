// #379 — `landscape_hash` : la signature du paysage ouvert d'un agent. Logique
// PURE extraite pour tester sans DB (façon decision-gate.ts / last-actor-gate.ts).
//
// Le hash change ssi le SET ouvert bouge (un ticket ouvre/ferme) OU un
// `last_actor_at` avance (quelqu'un a agi). C'est LE primitif unique partagé par
// la drained-strategy (#379) :
//   - **reset** : `hash ≠ prevHash` → le backoff repart, `once` se ré-arme ;
//   - **dédup set-aware** (Q2) : re-wake seulement quand le hash change (au lieu
//     du watermark count, qui ratait les swaps à compte constant).
//
// Composition (david `zxbfz2`/`nxpy76`) : sha1 du join trié des `<id>:<last_actor_at>`
// des tickets OUVERTS de la vision agent. O(N_ouverts) sur des lignes déjà
// chargées par listProjectsDetailed → pas de requête en plus, pas de cache
// (cf. #379 `n8fhv3` : le cache échouerait le critère « pas plus complexe »).

import { createHash } from "node:crypto";

/** Une entrée de paysage : un ticket ouvert + sa dernière activité. */
export interface LandscapeEntry {
    id: number;
    /** `tickets.last_actor_at` (#374) — null si jamais renseigné. */
    lastActorAt: string | null;
}

/**
 * Signature stable d'un ensemble de tickets ouverts. STRUCTURAL ONLY
 * (#813 cq4vvx / 2nnuq6 david) : le hash ne reflète QUE l'appartenance
 * au set ouvert (`<id>` triés), PAS les activités intra-ticket
 * (`last_actor_at` est ignoré).
 *
 * Effet : le hash ne bouge que sur open / close / reopen — pas sur chaque
 * comment. Ça rend le hash utilisable comme gate "fin de ligne" : si tout
 * le backlog est cooled et la FIFO vide, on fire un wake culturel UNIQUEMENT
 * si la structure du set a bougé (= un ticket a fermé / ouvert / reopen,
 * vraie info), sinon on reste silencieux.
 *
 * Un set vide a un hash stable (sha1 de la chaîne vide).
 *
 * `LandscapeEntry.lastActorAt` reste dans l'interface pour back-compat
 * des callers — juste ignoré ici.
 */
export function landscapeHash(entries: LandscapeEntry[]): string {
    const lines = entries.map((e) => String(e.id)).sort();
    return createHash("sha1").update(lines.join("\n")).digest("hex");
}
