<script setup lang="ts">
/**
 * Flat-list rendering of a thread's comments + relation rows + the
 * inline TLDR summary banner (#B.196 Layer 3 extract from ThreadView).
 * The parent builds `threadItems` (the unified ordered list) and
 * `decidersByMessage` (60s-window heuristic for "who decided this");
 * this component is pure UI — no state, no fetches.
 */
import type { Message } from "../lib/api";
import type { DeciderInfo, ThreadItem } from "../lib/threadItems";
import CommentNode from "./CommentNode.vue";

defineProps<{
    items: ThreadItem[];
    isEmpty: boolean;
    latestPendingId: number | null;
    decidersByMessage: Map<number, DeciderInfo>;
    latestSummaryUntil: { text: string; by: string | null; ts: string; id: number } | null;
    stageLabels: Record<string, string>;
}>();

const RELATION_LABELS: Record<string, { icon: string; verbOne: string; verbMany: string }> = {
    ticket_sub_added: {
        icon: "pi pi-sitemap",
        verbOne: "added sub-ticket",
        verbMany: "added sub-tickets",
    },
    ticket_referenced: {
        icon: "pi pi-link",
        verbOne: "referenced from",
        verbMany: "referenced from",
    },
    ticket_relation: {
        icon: "pi pi-share-alt",
        verbOne: "linked to",
        verbMany: "linked to",
    },
};

// #B.137: read meta.relation.kind from a ticket_relation event and
// produce the inline verb. `ignored` is the tombstone — surface it
// as "unlinked" so the timeline reads correctly.
function decodeRelationEvent(m: Message): { verb: string; target: number | null } {
    let kind: string | undefined;
    try {
        const meta = m.meta ? JSON.parse(m.meta) as { relation?: { kind?: string } } : null;
        kind = meta?.relation?.kind;
    } catch { /* malformed meta */ }
    const target = m.source_ticket_id ?? null;
    if (kind === "ignored") return { verb: "unlinked", target };
    if (kind) return { verb: `linked as ${kind}`, target };
    return { verb: "linked", target };
}

function shortTime(iso: string): string {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = 60_000, hr = 3_600_000, day = 86_400_000;
    if (diff < hr) return `${Math.max(1, Math.floor(diff / min))}m ago`;
    if (diff < day) return `${Math.floor(diff / hr)}h ago`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
    return d.toLocaleDateString();
}
</script>

<template>
    <div v-if="isEmpty" class="aiball-empty thread-no-comments">
        No comments yet — be the first to reply.
    </div>

    <ul v-else class="thread-comments">
        <template v-for="(item, idx) in items" :key="idx">
            <li
                v-if="item.kind === 'comment'"
                class="thread-comment"
            >
                <CommentNode
                    :msg="item.msg"
                    :show-pending-tag="item.msg.id === latestPendingId"
                    :decider="decidersByMessage.get(item.msg.id) ?? null"
                />
            </li>
            <li
                v-else-if="item.kind === 'summary_banner' && latestSummaryUntil"
                class="thread-summary-banner thread-summary-banner--inline"
                :title="`Current-state summary by ${latestSummaryUntil.by ?? 'author'} at ${new Date(latestSummaryUntil.ts).toLocaleString()}. Comments below (or above in top-down) are post-summary and not yet captured.`"
            >
                <i class="pi pi-bookmark thread-summary-banner__icon" />
                <span class="thread-summary-banner__label">tldr</span>
                <span class="thread-summary-banner__text">{{ latestSummaryUntil.text }}</span>
            </li>
            <li
                v-else-if="item.kind === 'relation_group'"
                class="thread-relation-row"
                :data-kind="item.msgs[0].kind"
            >
                <i :class="RELATION_LABELS[item.msgs[0].kind].icon" />
                <template v-if="item.msgs[0].kind === 'ticket_relation'">
                    <span class="thread-relation-row__refs">
                        <template v-for="(m, i2) in item.msgs" :key="m.id">
                            <span class="thread-relation-row__verb">{{ decodeRelationEvent(m).verb }}</span>
                            <a
                                v-if="decodeRelationEvent(m).target !== null"
                                :href="`/b/${decodeRelationEvent(m).target}`"
                                class="thread-relation-row__ref"
                            >#B.{{ decodeRelationEvent(m).target }}</a>
                            <template v-if="i2 < item.msgs.length - 1">,</template>
                        </template>
                    </span>
                </template>
                <template v-else>
                    <span class="thread-relation-row__verb">{{
                        item.msgs.length > 1
                            ? RELATION_LABELS[item.msgs[0].kind].verbMany
                            : RELATION_LABELS[item.msgs[0].kind].verbOne
                    }}</span>
                    <span class="thread-relation-row__refs">
                        <a
                            v-for="(m, i2) in item.msgs"
                            :key="m.id"
                            :href="`/b/${m.source_ticket_id}`"
                            class="thread-relation-row__ref"
                        >
                            #B.{{ m.source_ticket_id }}<span
                                v-if="m.source_ticket_stage && m.source_ticket_stage !== 'open'"
                                class="thread-relation-row__stage"
                                :data-stage="m.source_ticket_stage"
                            >{{ stageLabels[m.source_ticket_stage] }}</span><template v-if="i2 < item.msgs.length - 1">,</template>
                        </a>
                    </span>
                </template>
                <span class="thread-relation-row__meta">by {{ item.msgs[0].by_agent ?? "?" }} · {{ shortTime(item.msgs[0].created_at) }}</span>
            </li>
        </template>
    </ul>
</template>

<style src="./ThreadCommentsList.css" scoped></style>
