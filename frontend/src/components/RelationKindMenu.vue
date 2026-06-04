<script setup lang="ts">
/**
 * Popover content for change-kind / promote-ref / remove on a relation
 * (#B.196 Layer 3 extract from ThreadView). The Popover itself stays in
 * the parent (one shared ref, multiple trigger sources) — this component
 * is the body that goes inside.
 *
 * `target.kind` semantics (kept from the original inline impl):
 *   - `null`  → opened from a ticket-ref right-click, "promote ref to
 *               relation". The picker creates a fresh relation.
 *   - !== null → opened from an existing chip's menu, "change kind" or
 *               "remove" the relation.
 */
import { RELATION_KINDS, RELATION_LABELS, type RelationKind } from "../lib/relations";
import { formatTicketRef } from "../lib/formatting";

defineProps<{
    target: { target_ticket_id: number; kind: RelationKind | null } | null;
    targetTitle: string | null;
    busy: boolean;
}>();
const emit = defineEmits<{
    (e: "close"): void;
    (e: "pick", kind: RelationKind): void;
    (e: "remove"): void;
}>();

// `ignored` is the tombstone (handled by the remove button). Lineage
// (#271 child_of / parent_of) IS pickable — change-kind covers
// re-parenting, demoting to relates_to, etc. The add-form picker
// (threadRelations.ts) still hides lineage so the default add stays
// soft. Backend enforces DAG via lineageWouldCycle.
const pickableKinds = RELATION_KINDS.filter((x) => x !== "ignored");
</script>

<template>
    <div class="relation-menu" v-if="target">
        <!-- #B.159: explicit close (X) so the popup can be dismissed
             without an outside-click hunt. -->
        <button
            type="button"
            class="relation-menu__close"
            title="Close"
            @click="emit('close')"
        >
            <i class="pi pi-times" />
        </button>
        <div class="relation-menu__title">
            <template v-if="target.kind === null">
                Promote ref to relation —
                <strong>{{ formatTicketRef(target.target_ticket_id) }}</strong>
            </template>
            <template v-else>
                Relation to <strong>{{ formatTicketRef(target.target_ticket_id) }}</strong>
            </template>
            <div v-if="targetTitle" class="relation-menu__target-title">
                {{ targetTitle }}
            </div>
        </div>
        <div class="relation-menu__kinds">
            <button
                v-for="k in pickableKinds"
                :key="k"
                type="button"
                class="relation-menu__kind-btn"
                :class="{ 'relation-menu__kind-btn--current': k === target.kind }"
                :disabled="busy"
                @click="emit('pick', k)"
            >
                {{ RELATION_LABELS[k] }}
            </button>
        </div>
        <button
            v-if="target.kind !== null"
            type="button"
            class="relation-menu__remove"
            :disabled="busy"
            title="Remove this relation (posts an `ignored` tombstone — re-add anytime)"
            @click="emit('remove')"
        >
            <i class="pi pi-times" /> remove
        </button>
    </div>
</template>

<style src="./RelationKindMenu.css" scoped></style>
