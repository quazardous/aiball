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
 * Signature stable d'un ensemble de tickets ouverts. Tri sur la ligne
 * `<id>:<last_actor_at>` (donc déterministe quel que soit l'ordre d'entrée),
 * puis sha1. Un set vide a un hash stable (sha1 de la chaîne vide) — utile pour
 * distinguer « rien d'ouvert » d'un set non vide sans cas particulier.
 */
export function landscapeHash(entries: LandscapeEntry[]): string {
    const lines = entries
        .map((e) => `${e.id}:${e.lastActorAt ?? ""}`)
        .sort();
    return createHash("sha1").update(lines.join("\n")).digest("hex");
}
