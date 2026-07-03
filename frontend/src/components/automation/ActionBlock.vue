<script setup lang="ts">
/**
 * #457 slice 5.3b — single action block (one entry in a rule's `actions[]`
 * stack, per david `aa48pd`).
 *
 * Layout : kind picker | per-kind inputs | × remove. The kind picker
 * resets the value fields to sensible defaults when switched, so a
 * switch from `assign` → `set_priority` doesn't carry the consumer_id
 * forward.
 */
import { computed, inject, ref } from "vue";
import AutoComplete from "primevue/autocomplete";
import Select from "primevue/select";
import Button from "primevue/button";
import { LEAF_SOURCES_KEY, type LeafSources } from "../../lib/leaf-sources";
import type { AutomationAction } from "../../lib/api";

const props = defineProps<{
    action: AutomationAction;
}>();
const emit = defineEmits<{
    (e: "update", action: AutomationAction): void;
    (e: "remove"): void;
}>();

// #522 (suite shqdjp) — pareil que ConditionLeafBlock : on inject les
// sources `provide`ées par RuleEditor (`consumers`, `tags`) pour alimenter
// l'AutoComplete des champs assign/notify (consumer_id) + add_tag (tag).
const sources = inject<LeafSources | null>(LEAF_SOURCES_KEY, null);
const consumerSuggestions = ref<string[]>([]);
const tagSuggestions = ref<string[]>([]);
function onConsumerComplete(e: { query: string }) {
    const q = (e.query ?? "").trim().toLowerCase();
    const all = sources?.consumers.value ?? [];
    consumerSuggestions.value = q
        ? all.filter((s) => s.toLowerCase().includes(q)).slice(0, 50)
        : all.slice(0, 50);
}
function onTagComplete(e: { query: string }) {
    const q = (e.query ?? "").trim().toLowerCase();
    const all = sources?.tags.value ?? [];
    tagSuggestions.value = q
        ? all.filter((s) => s.toLowerCase().includes(q)).slice(0, 50)
        : all.slice(0, 50);
}

const kindOptions: { label: string; value: AutomationAction["kind"] }[] = [
    { label: "assign to consumer", value: "assign" },
    { label: "set priority", value: "set_priority" },
    { label: "moderation decision", value: "decision" },
    { label: "pickup gate", value: "pickup" },
    { label: "add tag", value: "add_tag" },
    { label: "notify consumer", value: "notify" },
];
const decisionOptions = [
    { label: "auto-approve", value: "auto" },
    { label: "send to review", value: "review" },
];
const pickupOptions = [
    { label: "only (include)", value: "only" },
    { label: "except (exclude)", value: "except" },
];
const priorityOptions = [
    { label: "urgent", value: "urgent" },
    { label: "high", value: "high" },
    { label: "normal", value: "normal" },
    { label: "low", value: "low" },
];

const consumerId = computed(() => {
    if (props.action.kind === "assign" || props.action.kind === "notify") {
        return props.action.consumer_id;
    }
    return "";
});
const decisionValue = computed(() => props.action.kind === "decision" ? props.action.decision : "auto");
const pickupMode = computed(() => props.action.kind === "pickup" ? props.action.mode : "only");
const tagValue = computed(() => props.action.kind === "add_tag" ? props.action.tag : "");
const priorityValue = computed(() => props.action.kind === "set_priority" ? props.action.priority : "normal");

function setKind(newKind: AutomationAction["kind"]) {
    switch (newKind) {
        case "assign":
            emit("update", { kind: "assign", consumer_id: "" });
            return;
        case "notify":
            emit("update", { kind: "notify", consumer_id: "" });
            return;
        case "decision":
            emit("update", { kind: "decision", decision: "auto" });
            return;
        case "pickup":
            emit("update", { kind: "pickup", mode: "only" });
            return;
        case "add_tag":
            emit("update", { kind: "add_tag", tag: "" });
            return;
        case "set_priority":
            emit("update", { kind: "set_priority", priority: "normal" });
            return;
    }
}

function setConsumer(v: string | undefined) {
    const s = v ?? "";
    if (props.action.kind === "assign") emit("update", { kind: "assign", consumer_id: s });
    else if (props.action.kind === "notify") emit("update", { kind: "notify", consumer_id: s });
}
function setDecision(v: "auto" | "review") {
    emit("update", { kind: "decision", decision: v });
}
function setPickup(v: "only" | "except") {
    emit("update", { kind: "pickup", mode: v });
}
function setTag(v: string | undefined) {
    emit("update", { kind: "add_tag", tag: v ?? "" });
}
function setPriority(v: "urgent" | "high" | "normal" | "low") {
    emit("update", { kind: "set_priority", priority: v });
}
</script>

<template>
    <div class="action-block" :class="`action-block--${action.kind}`">
        <Select
            :model-value="action.kind"
            :options="kindOptions"
            option-label="label"
            option-value="value"
            class="action-block__kind"
            @update:model-value="setKind"
        />

        <template v-if="action.kind === 'assign' || action.kind === 'notify'">
            <span class="action-block__arrow">→</span>
            <!-- #522 shqdjp : AutoComplete avec consumers source (single
                 select — une action = un consumer_id) au lieu du plain
                 InputText. dropdown pour browse la liste sans typer. -->
            <AutoComplete
                :model-value="consumerId"
                :suggestions="consumerSuggestions"
                placeholder="consumer_id"
                dropdown
                class="action-block__value"
                @complete="onConsumerComplete"
                @update:model-value="setConsumer"
            />
        </template>
        <template v-else-if="action.kind === 'decision'">
            <Select
                :model-value="decisionValue"
                :options="decisionOptions"
                option-label="label"
                option-value="value"
                class="action-block__value"
                @update:model-value="setDecision"
            />
        </template>
        <template v-else-if="action.kind === 'pickup'">
            <Select
                :model-value="pickupMode"
                :options="pickupOptions"
                option-label="label"
                option-value="value"
                class="action-block__value"
                @update:model-value="setPickup"
            />
        </template>
        <template v-else-if="action.kind === 'add_tag'">
            <span class="action-block__arrow">«</span>
            <!-- #522 shqdjp : pareil — AutoComplete avec tags catalog source.
                 Single select (une action add_tag = un tag). -->
            <AutoComplete
                :model-value="tagValue"
                :suggestions="tagSuggestions"
                placeholder="tag name"
                dropdown
                class="action-block__value"
                @complete="onTagComplete"
                @update:model-value="setTag"
            />
        </template>
        <template v-else-if="action.kind === 'set_priority'">
            <Select
                :model-value="priorityValue"
                :options="priorityOptions"
                option-label="label"
                option-value="value"
                class="action-block__value"
                @update:model-value="setPriority"
            />
        </template>

        <Button
            icon="pi pi-times"
            text
            rounded
            size="small"
            severity="secondary"
            class="action-block__remove"
            :title="`Remove this action`"
            @click="emit('remove')"
        />
    </div>
</template>

<style scoped>
.action-block {
    display: grid;
    grid-template-columns: 14rem auto 1fr 2rem;
    gap: 0.4rem;
    align-items: center;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--p-content-border-color);
    border-left: 3px solid var(--p-purple-500);
    border-radius: 0.35rem;
    background: color-mix(in srgb, var(--p-purple-500) 4%, var(--p-content-background, transparent));
}
.action-block__kind {
    min-width: 0;
}
.action-block__arrow {
    color: var(--p-text-muted-color);
    font-family: var(--font-mono);
    text-align: center;
    width: 1.2rem;
}
.action-block__value {
    min-width: 0;
    width: 100%;
}
</style>
