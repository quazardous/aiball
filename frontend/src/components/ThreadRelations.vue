<script setup lang="ts">
/**
 * Relations cartouche — chip row + inline add-relation form (#B.196 Layer 3
 * partial extract from ThreadView).
 *
 * State (formOpen / target / kind) is hoisted via v-model so the parent can
 * render TWO instances (bottom-up article + top-down headline) sharing the
 * same form: switching layout mid-edit keeps what the user typed. The
 * change-kind / remove popover stays in the parent (one popover, multiple
 * trigger sources) — we just emit `open-menu` and let the parent anchor it.
 */
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import RelationChip from "./RelationChip.vue";
import type { TicketRelation } from "../lib/api";
import type { RelationKind } from "../lib/relations";

defineProps<{
    relations: TicketRelation[];
    formOpen: boolean;
    formTarget: string;
    formKind: RelationKind;
    busy: boolean;
    relationKindOptions: { label: string; value: RelationKind }[];
    /** Per-instance key prefix so v-for keys don't collide when two
     *  ThreadRelations instances render the same chips at once. */
    instanceKeyPrefix?: string;
}>();
const emit = defineEmits<{
    (e: "update:formOpen", v: boolean): void;
    (e: "update:formTarget", v: string): void;
    (e: "update:formKind", v: RelationKind): void;
    (e: "submit"): void;
    (e: "open-menu", payload: { event: Event; relation: { target_ticket_id: number; kind: RelationKind } }): void;
}>();
</script>

<template>
    <div class="thread-relations">
        <span class="thread-relations__label">
            <i class="pi pi-share-alt" />
            Relations
        </span>
        <RelationChip
            v-for="r in relations"
            :key="`${instanceKeyPrefix ?? ''}${r.target_ticket_id}-${r.last_event_id}`"
            :relation="r"
            @open-menu="(payload) => emit('open-menu', payload)"
        />
        <Button
            v-if="!formOpen"
            icon="pi pi-plus"
            label="relation"
            size="small"
            severity="secondary"
            text
            title="Link this ticket to another with a typed relation (#B.123 phase B)"
            @click="emit('update:formOpen', true)"
        />
    </div>
    <div v-if="formOpen" class="thread-relations-form">
        <InputText
            :model-value="formTarget"
            placeholder="target ticket — 42 or #B.42"
            size="small"
            :disabled="busy"
            style="max-width: 14rem"
            @update:model-value="(v) => emit('update:formTarget', String(v ?? ''))"
            @keydown.enter.prevent="emit('submit')"
        />
        <Select
            :model-value="formKind"
            :options="relationKindOptions"
            option-label="label"
            option-value="value"
            size="small"
            :disabled="busy"
            style="min-width: 10rem"
            @update:model-value="(v) => emit('update:formKind', v as RelationKind)"
        />
        <Button
            label="add"
            icon="pi pi-check"
            size="small"
            :loading="busy"
            :disabled="!formTarget.trim()"
            @click="emit('submit')"
        />
        <Button
            label="cancel"
            size="small"
            severity="secondary"
            text
            :disabled="busy"
            @click="emit('update:formOpen', false); emit('update:formTarget', '')"
        />
    </div>
</template>
