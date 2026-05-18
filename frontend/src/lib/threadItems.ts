/**
 * View-derived computations for a single thread (#B.196 Layer 3
 * extract from ThreadView). All four computeds depend on the same
 * `data` ref (the loaded thread payload) and the global `topDown`
 * pref. Co-locating them here keeps the derivations next to each
 * other (decidersByMessage feeds the comments, threadItems consumes
 * latestSummaryUntil for banner insertion) and shrinks ThreadView
 * to mostly orchestration.
 *
 * Exposed types (ThreadItem, DeciderInfo) are also imported by
 * ThreadCommentsList.vue so the data flows through unchanged.
 */
import { computed, type Ref } from "vue";
import { type Message, type ThreadView as ThreadViewData } from "./api";
import { readDecision } from "./decisions";
import { topDown } from "./prefs";

export type ThreadItem =
    | { kind: "comment"; msg: Message }
    | { kind: "relation_group"; msgs: Message[] }
    | { kind: "summary_banner" };

export interface DeciderInfo {
    action: "accepted" | "rejected";
    target_id: number;
    target_hashid: string | null;
    target_kind: string;
}

/**
 * Compact one-word labels for the lifecycle stage badge rendered
 * next to ticket refs in relation rows and sub-ticket recap items
 * (per #B.70 follow-up). `open` is intentionally NOT in the table —
 * it's the default, no badge needed.
 */
export const STAGE_LABELS: Record<string, string> = {
    rejected: "rejected",
    "closed-resolved": "closed ✓",
    closed: "closed",
    resolved: "resolved",
    snoozed: "snoozed",
    pending: "pending",
};

function isRelationKind(k: Message["kind"]): boolean {
    return k === "ticket_sub_added" || k === "ticket_referenced" || k === "ticket_relation";
}

export function useThreadItems(data: Ref<ThreadViewData | null>) {
    // Top-level (root) comments shown chronologically. Threading is
    // intentionally flat (#B.36): conversations live in one stream
    // and authors quote with > or #N to refer back. The data layer
    // still tolerates parent_message_id for backward compatibility
    // but the UI ignores it.
    const flatComments = computed<Message[]>(() => {
        if (!data.value) return [];
        const sorted = [...data.value.comments].sort((a, b) => a.id - b.id);
        return topDown.value ? sorted.reverse() : sorted;
    });

    // #B.129 follow-up: decorate the comment that triggered an
    // accept/reject act. Heuristic (frontend-only, no schema
    // change): a comment posted by user X within 60s AFTER a
    // decision flipped to accepted/rejected by X on a PRIOR comment
    // is the "decider comment". Build a Map<message_id,
    // {action, target_id, target_hashid}>. Limitation: 60s window
    // can both false-positive (X commented for unrelated reasons
    // right after deciding) and false-negative (X took >60s to
    // type the explanation). Acceptable for v1; revisit if david
    // flags noise.
    const decidersByMessage = computed<Map<number, DeciderInfo>>(() => {
        const out = new Map<number, DeciderInfo>();
        if (!data.value) return out;
        const sorted = [...data.value.comments].sort((a, b) => a.id - b.id);
        for (let i = 0; i < sorted.length; i++) {
            const target = sorted[i];
            if (target.kind !== "comment_added") continue;
            const d = readDecision(target);
            if (!d || d.status === "pending" || !d.decided_by || !d.decided_at) continue;
            const decidedAt = new Date(d.decided_at).getTime();
            // Find the next comment by d.decided_by within 60s
            for (let j = i + 1; j < sorted.length; j++) {
                const cand = sorted[j];
                if (cand.kind !== "comment_added") continue;
                if (cand.by_agent !== d.decided_by) continue;
                const dt = new Date(cand.created_at).getTime() - decidedAt;
                if (dt < -1000) continue; // candidate posted before the decide
                if (dt > 60_000) break; // too late, give up
                // Don't tag the decided comment itself (e.g. if the
                // decision sat on the same author's prior comment).
                if (cand.id === target.id) continue;
                out.set(cand.id, {
                    action: d.status as "accepted" | "rejected",
                    target_id: target.id,
                    target_hashid: target.hashid ?? null,
                    target_kind: d.kind,
                });
                break;
            }
        }
        return out;
    });

    // #B.130: latest summary_until wins. Scan all approved comments,
    // pick the most recent one carrying `meta.summary_until`. That's
    // the canonical "current state of the thread" snippet to show
    // as a banner. Older summary_until values are invisible/lost
    // (per david).
    const latestSummaryUntil = computed<{ text: string; by: string | null; ts: string; id: number } | null>(() => {
        if (!data.value) return null;
        let best: { text: string; by: string | null; ts: string; id: number } | null = null;
        for (const m of data.value.comments) {
            if (m.kind !== "comment_added") continue;
            if (m.status === "rejected") continue;
            if (!m.meta) continue;
            let summaryUntil: string | undefined;
            try {
                summaryUntil = (JSON.parse(m.meta) as { summary_until?: string }).summary_until;
            } catch { continue; }
            if (!summaryUntil) continue;
            if (!best || m.id > best.id) {
                best = { text: summaryUntil, by: m.by_agent, ts: m.created_at, id: m.id };
            }
        }
        return best;
    });

    // Relation events (`ticket_sub_added` / `ticket_referenced` /
    // `ticket_relation`) render compact — they're machine-generated
    // notifications, not authored content. Consecutive same-kind
    // same-author events within a 60s window collapse into one row:
    // "added 8 sub-tickets: #B.66, #B.67, …" (per user feedback on
    // #B.62: "gère la factorisation en front si plusieurs relation
    // se suivent"). The relation-row rendering itself lives in
    // sibling ThreadCommentsList.vue — this builder only assembles
    // the abstract ThreadItem[] sequence.
    const threadItems = computed<ThreadItem[]>(() => {
        // Walk the ASC-sorted comments and insert the TLDR banner
        // right AFTER the carrier comment in source order. The
        // optional reverse for top-down at the end keeps the banner
        // between the carrier and the post-summary newer comments
        // in both modes (david: "intercalé entre le commentaire
        // qu'il porte et les suivants non encore pris en compte").
        // #B.130.
        if (!data.value) return [];
        const ascItems = [...data.value.comments].sort((a, b) => a.id - b.id);
        const summaryCarrierId = latestSummaryUntil.value?.id ?? null;
        const out: ThreadItem[] = [];
        let i = 0;
        while (i < ascItems.length) {
            const m = ascItems[i];
            if (!isRelationKind(m.kind)) {
                out.push({ kind: "comment", msg: m });
                if (m.id === summaryCarrierId) {
                    out.push({ kind: "summary_banner" });
                }
                i++;
                continue;
            }
            // Collect a run of same-kind same-author events within 60s.
            const group: Message[] = [m];
            let j = i + 1;
            while (j < ascItems.length) {
                const n = ascItems[j];
                if (n.kind !== m.kind) break;
                if (n.by_agent !== m.by_agent) break;
                const dt = Math.abs(
                    new Date(n.created_at).getTime() - new Date(m.created_at).getTime(),
                );
                if (dt > 60_000) break;
                group.push(n);
                j++;
            }
            out.push({ kind: "relation_group", msgs: group });
            // Banner insertion also applies if the carrier was the
            // last in a relation group (edge case: rare in practice —
            // carriers are comment_added, not relations — but
            // defensive).
            if (group.some((x) => x.id === summaryCarrierId)) {
                out.push({ kind: "summary_banner" });
            }
            i = j;
        }
        return topDown.value ? out.reverse() : out;
    });

    // Only the most recent pending entry surfaces a "pending" tag —
    // older pending rows would just add noise once the moderator's
    // attention is already drawn to the latest one.
    const latestPendingId = computed<number | null>(() => {
        let latest: number | null = null;
        for (const c of flatComments.value) {
            if (c.status === "pending") latest = c.id;
        }
        return latest;
    });

    return {
        flatComments,
        decidersByMessage,
        latestSummaryUntil,
        threadItems,
        latestPendingId,
    };
}
