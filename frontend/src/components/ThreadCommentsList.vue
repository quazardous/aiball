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
import { formatTicketRef } from "../lib/formatting";
import { relativeTime as shortTime } from "../lib/format";
import { ticketHref } from "../lib/base";
import { relationRowLabel } from "../lib/relationRows";
import CommentNode from "./CommentNode.vue";
import MarkdownView from "./MarkdownView.vue";

defineProps<{
    items: ThreadItem[];
    isEmpty: boolean;
    latestPendingId: number | null;
    decidersByMessage: Map<number, DeciderInfo>;
    latestSummaryUntil: { text: string; by: string | null; ts: string; id: number } | null;
    stageLabels: Record<string, string>;
}>();



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
                <!-- #353: render summary_until as markdown (sanitized) for
                     readability — agents still read the raw text via MCP. -->
                <MarkdownView class="thread-summary-banner__text" :source="latestSummaryUntil.text" />
            </li>
            <li
                v-else-if="item.kind === 'relation_group'"
                class="thread-relation-row"
                :data-kind="item.msgs[0].kind"
            >
                <i :class="relationRowLabel(item.msgs[0].kind).icon" />
                <template v-if="item.msgs[0].kind === 'ticket_relation'">
                    <span class="thread-relation-row__refs">
                        <template v-for="(m, i2) in item.msgs" :key="m.id">
                            <span class="thread-relation-row__verb">{{ decodeRelationEvent(m).verb }}</span>
                            <a
                                v-if="decodeRelationEvent(m).target !== null"
                                :href="ticketHref(decodeRelationEvent(m).target as number)"
                                class="thread-relation-row__ref"
                            >{{ formatTicketRef(decodeRelationEvent(m).target as number) }}</a>
                            <template v-if="i2 < item.msgs.length - 1">,</template>
                        </template>
                    </span>
                </template>
                <template v-else>
                    <span class="thread-relation-row__verb">{{
                        item.msgs.length > 1
                            ? relationRowLabel(item.msgs[0].kind).verbMany
                            : relationRowLabel(item.msgs[0].kind).verbOne
                    }}</span>
                    <span class="thread-relation-row__refs">
                        <a
                            v-for="(m, i2) in item.msgs"
                            :key="m.id"
                            :href="ticketHref(m.source_ticket_id as number)"
                            :title="m.source_ticket_title ? `${formatTicketRef(m.source_ticket_id as number)}: ${m.source_ticket_title}` : undefined"
                            class="thread-relation-row__ref"
                        >
                            {{ formatTicketRef(m.source_ticket_id as number) }}<span
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
