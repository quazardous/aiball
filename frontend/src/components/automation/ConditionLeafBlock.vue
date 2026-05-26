<script setup lang="ts">
/**
 * #457 slice 5.3b — leaf condition block (one tile of the tree).
 *
 * The leaf knows its `field` and renders the right input for the value :
 *   - `kind`        → Select (ticket_created | comment_added | …)
 *   - `intent`      → Select (panic | request | question | fyi)
 *   - `priority`    → Select (urgent | high | normal | low)
 *   - `tags`        → comma-separated string list + op picker (includes / in)
 *   - everything else (project, by_agent, tag_added, scope_consumer) → text
 *
 * The op picker is hidden when the field has only one sensible operator
 * (e.g. `tag_added` is always `eq`). For `tags`, it's `includes` (the
 * ticket carries this tag) — `in` is also possible if you want the
 * inverse semantic but most users want `includes`.
 *
 * Emits `update` with the rebuilt leaf node ; the parent splices it
 * into its `children` array. `remove` fires to ask the parent to drop
 * this leaf entirely.
 */
import { computed } from "vue";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Button from "primevue/button";
import type {
    ConditionField,
    ConditionOp,
    ConditionTree,
} from "../../lib/api";

const props = defineProps<{
    node: ConditionTree & { kind: "leaf" };
}>();
const emit = defineEmits<{
    (e: "update", node: ConditionTree): void;
    (e: "remove"): void;
}>();

const fieldOptions: { label: string; value: ConditionField }[] = [
    { label: "project", value: "project" },
    { label: "kind", value: "kind" },
    { label: "by_agent", value: "by_agent" },
    { label: "intent", value: "intent" },
    { label: "priority", value: "priority" },
    { label: "tags (any-of)", value: "tags" },
    { label: "tag_added", value: "tag_added" },
    { label: "scope_consumer", value: "scope_consumer" },
];

const kindOptions = [
    { label: "ticket_created", value: "ticket_created" },
    { label: "comment_added", value: "comment_added" },
    { label: "ticket_closed", value: "ticket_closed" },
];
const intentOptions = [
    { label: "panic", value: "panic" },
    { label: "request", value: "request" },
    { label: "question", value: "question" },
    { label: "fyi", value: "fyi" },
];
const priorityOptions = [
    { label: "urgent", value: "urgent" },
    { label: "high", value: "high" },
    { label: "normal", value: "normal" },
    { label: "low", value: "low" },
];
const opOptions: { label: string; value: ConditionOp }[] = [
    { label: "=", value: "eq" },
    { label: "≠", value: "neq" },
];
const tagsOpOptions: { label: string; value: ConditionOp }[] = [
    { label: "⊇ (carries tag)", value: "includes" },
    { label: "∈ (in list)", value: "in" },
];

const valueAsString = computed<string>(() => {
    const v = props.node.value;
    if (v == null) return "";
    if (Array.isArray(v)) return v.join(",");
    return String(v);
});

function setField(field: ConditionField) {
    // Reset value + op to sensible defaults for the new field type. Avoids
    // carrying e.g. an intent value forward into a priority block.
    const next: ConditionTree = {
        kind: "leaf",
        field,
        op: field === "tags" ? "includes" : "eq",
        value: field === "tags" ? [] : "",
    };
    emit("update", next);
}

function setOp(op: ConditionOp) {
    emit("update", { ...props.node, op });
}

function setValueText(v: string | undefined) {
    const s = v ?? "";
    if (props.node.field === "tags") {
        // Comma-separated → array. Trim + drop empties.
        const arr = s.split(",").map((t) => t.trim()).filter(Boolean);
        emit("update", { ...props.node, value: arr });
    } else {
        emit("update", { ...props.node, value: s });
    }
}

function setValueSelect(v: string) {
    emit("update", { ...props.node, value: v });
}
</script>

<template>
    <div class="leaf-block" :class="`leaf-block--${node.field}`">
        <Select
            :model-value="node.field"
            :options="fieldOptions"
            option-label="label"
            option-value="value"
            class="leaf-block__field"
            @update:model-value="setField"
        />

        <!-- Op picker : suppressed when only one operator makes sense. -->
        <template v-if="node.field === 'tags'">
            <Select
                :model-value="node.op"
                :options="tagsOpOptions"
                option-label="label"
                option-value="value"
                class="leaf-block__op"
                @update:model-value="setOp"
            />
        </template>
        <template v-else-if="node.field === 'tag_added' || node.field === 'scope_consumer'">
            <!-- Hidden — `=` is the only meaningful op. Reserve the slot
                 visually so the layout stays aligned across rows. -->
            <span class="leaf-block__op-fixed">=</span>
        </template>
        <template v-else>
            <Select
                :model-value="node.op"
                :options="opOptions"
                option-label="label"
                option-value="value"
                class="leaf-block__op"
                @update:model-value="setOp"
            />
        </template>

        <!-- Value input : per-field. -->
        <template v-if="node.field === 'kind'">
            <Select
                :model-value="valueAsString"
                :options="kindOptions"
                option-label="label"
                option-value="value"
                class="leaf-block__value"
                @update:model-value="setValueSelect"
            />
        </template>
        <template v-else-if="node.field === 'intent'">
            <Select
                :model-value="valueAsString"
                :options="intentOptions"
                option-label="label"
                option-value="value"
                class="leaf-block__value"
                @update:model-value="setValueSelect"
            />
        </template>
        <template v-else-if="node.field === 'priority'">
            <Select
                :model-value="valueAsString"
                :options="priorityOptions"
                option-label="label"
                option-value="value"
                class="leaf-block__value"
                @update:model-value="setValueSelect"
            />
        </template>
        <template v-else-if="node.field === 'tags'">
            <InputText
                :model-value="valueAsString"
                placeholder="tag1, tag2"
                class="leaf-block__value"
                @update:model-value="setValueText"
            />
        </template>
        <template v-else>
            <InputText
                :model-value="valueAsString"
                placeholder="(value)"
                class="leaf-block__value"
                @update:model-value="setValueText"
            />
        </template>

        <Button
            icon="pi pi-times"
            text
            rounded
            size="small"
            severity="secondary"
            class="leaf-block__remove"
            :title="`Remove this condition`"
            @click="emit('remove')"
        />
    </div>
</template>

<style scoped>
.leaf-block {
    display: grid;
    grid-template-columns: 11rem auto 1fr 2rem;
    gap: 0.4rem;
    align-items: center;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--p-content-border-color);
    border-left: 3px solid var(--p-cyan-500);
    border-radius: 0.35rem;
    background: color-mix(in srgb, var(--p-cyan-500) 4%, var(--p-content-background, transparent));
}
.leaf-block__field {
    min-width: 0;
}
.leaf-block__op {
    min-width: 5rem;
}
.leaf-block__op-fixed {
    color: var(--p-text-muted-color);
    font-family: ui-monospace, monospace;
    text-align: center;
    width: 5rem;
}
.leaf-block__value {
    min-width: 0;
    width: 100%;
}
</style>
