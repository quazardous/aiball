/**
 * #3285 — what a read adds to message rows before they leave: their tags (one
 * bulk SELECT for many rows) and their votes as the viewer sees them. Shared by
 * the bus methods that answer messages; moved from src/api/_helpers.ts.
 */
import { listMessageTags, tagsForMessages, type Tag } from "../db.js";
import { parseMeta } from "../questions.js";

/**
 * Decorate one or many messages with their tags so callers can render
 * them without an N+1 round-trip. Uses one bulk SELECT regardless of
 * the number of messages.
 */
export function withTags<T extends { id: number }>(rows: T[]): (T & { tags: Tag[] })[] {
    const map = tagsForMessages(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, tags: map.get(r.id) ?? [] }));
}

export function withTagsOne<T extends { id: number }>(row: T): T & { tags: Tag[] } {
    return { ...row, tags: listMessageTags(row.id) };
}

/**
 * #518 (MVP option A) — vote summary lisible par le front. `up` / `down` =
 * compteurs agrégés depuis meta.votes ; `mine` = la valeur du viewer
 * courant (`1 | -1 | null`). Décoré sur les messages du thread + sur
 * la réponse du POST /vote pour que l'UI se mette à jour atomiquement.
 */
export interface VoteSummary {
    up: number;
    down: number;
    mine: 1 | -1 | null;
}

export function summarizeVotes(meta: string | null, viewer: string): VoteSummary {
    const votes = parseMeta(meta).votes ?? {};
    let up = 0;
    let down = 0;
    let mine: 1 | -1 | null = null;
    for (const [voter, v] of Object.entries(votes)) {
        if (v === 1) up += 1;
        else if (v === -1) down += 1;
        if (voter === viewer) mine = v;
    }
    return { up, down, mine };
}

/** Décore un tableau de messages avec leur votes_summary pour le viewer
 *  courant. Renvoie le row tel quel + un champ `votes_summary` ajouté. */
export function withVotes<T extends { id: number; kind: string; meta?: string | null }>(
    rows: T[],
    viewer: string,
): (T & { votes_summary?: VoteSummary })[] {
    return rows.map((r) => {
        if (r.kind !== "comment_added") return r;
        return { ...r, votes_summary: summarizeVotes(r.meta ?? null, viewer) };
    });
}

export function withVotesOne<T extends { id: number; kind: string; meta?: string | null }>(
    row: T,
    viewer: string,
): T & { votes_summary?: VoteSummary } {
    if (row.kind !== "comment_added") return row;
    return { ...row, votes_summary: summarizeVotes(row.meta ?? null, viewer) };
}
