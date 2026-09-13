<script setup lang="ts">
import { computed } from "vue";
import { RELATION_LABELS, type RelationKind } from "../lib/relations";
import { formatTicketRef } from "../lib/formatting";
import { ticketHref } from "../lib/base";
import type { TicketRelation } from "../lib/api";

const props = defineProps<{
    relation: TicketRelation;
}>();

// Reciprocal chips are owned by the other side — edit from the source
// ticket. Lineage (child_of / parent_of) is editable from its own side
// (#794) : the user can re-parent, demote to relates_to, or remove via
// the standard chip menu ; the backend (lineageWouldCycle) enforces the
// DAG invariant.
const editable = computed(() => !props.relation.reciprocal);

const emit = defineEmits<{
    (e: "open-menu", payload: { event: Event; relation: { target_ticket_id: number; kind: RelationKind } }): void;
}>();

// #2432 david — the chip names its target by number; hovering says what that
// ticket is. The title leads, the provenance (who set the relation, when)
// follows on its own line.
const tooltip = computed(() => {
    const r = props.relation;
    const ref = formatTicketRef(r.target_ticket_id);
    const head = r.target_title ? `${ref}: ${r.target_title}` : `Open ${ref}`;
    const kind = RELATION_LABELS[r.reciprocal
        ? (r.kind === "blocks" ? "depends_on" : r.kind === "depends_on" ? "blocks" : r.kind)
        : r.kind];
    const when = new Date(r.last_event_at).toLocaleString();
    const provenance = r.reciprocal
        ? `reciprocal view of \`${kind}\` set on ${ref} by ${r.by_agent ?? "?"} on ${when}`
        : `${kind}, set by ${r.by_agent ?? "?"} on ${when}`;
    return `${head}\n${provenance}`;
});

// #B.123 follow-up: target stage badge so the chip carries the
// target ticket's lifecycle state inline. "open" suppresses the
// badge (default state = no extra noise).
const STAGE_LABELS: Record<string, string> = {
    rejected: "rejected",
    "closed-resolved": "closed ✓",
    closed: "closed",
    resolved: "resolved",
    snoozed: "snoozed",
    pending: "pending",
};
</script>

<template>
    <span
        class="thread-relations__chip"
        :class="{ 'thread-relations__chip--reciprocal': relation.reciprocal }"
        :data-kind="relation.kind"
    >
        <a
            :href="ticketHref(relation.target_ticket_id)"
            class="thread-relations__chip-link"
            :title="tooltip"
        >
            <span class="thread-relations__kind">{{ RELATION_LABELS[relation.kind] }}</span>
            <span class="thread-relations__target">{{ formatTicketRef(relation.target_ticket_id) }}</span>
            <span
                v-if="relation.target_stage && relation.target_stage !== 'open' && STAGE_LABELS[relation.target_stage]"
                class="thread-relations__stage"
                :data-stage="relation.target_stage"
            >{{ STAGE_LABELS[relation.target_stage] }}</span>
        </a>
        <button
            v-if="editable"
            type="button"
            class="thread-relations__menu-btn"
            title="Change kind or remove"
            @click.stop.prevent="emit('open-menu', { event: $event, relation: { target_ticket_id: relation.target_ticket_id, kind: relation.kind } })"
        >▾</button>
    </span>
</template>
