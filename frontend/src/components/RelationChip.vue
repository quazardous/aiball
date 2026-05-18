<script setup lang="ts">
import { RELATION_LABELS, type RelationKind } from "../lib/relations";
import type { TicketRelation } from "../lib/api";

defineProps<{
    relation: TicketRelation;
}>();

const emit = defineEmits<{
    (e: "open-menu", payload: { event: Event; relation: { target_ticket_id: number; kind: RelationKind } }): void;
}>();
</script>

<template>
    <span
        class="thread-relations__chip"
        :data-kind="relation.kind"
    >
        <a
            :href="`/b/${relation.target_ticket_id}`"
            class="thread-relations__chip-link"
            :title="`Open #B.${relation.target_ticket_id} — ${RELATION_LABELS[relation.kind]}, set by ${relation.by_agent ?? '?'} on ${new Date(relation.last_event_at).toLocaleString()}`"
        >
            <span class="thread-relations__kind">{{ RELATION_LABELS[relation.kind] }}</span>
            <span class="thread-relations__target">#B.{{ relation.target_ticket_id }}</span>
        </a>
        <button
            type="button"
            class="thread-relations__menu-btn"
            title="Change kind or remove"
            @click.stop.prevent="emit('open-menu', { event: $event, relation: { target_ticket_id: relation.target_ticket_id, kind: relation.kind } })"
        >▾</button>
    </span>
</template>
