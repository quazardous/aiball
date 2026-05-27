<script setup lang="ts">
/**
 * #504 — leaf condition block, retravaillé : un widget spécialisé par field +
 * autocomplete (depuis `leaf-sources` injecté par RuleEditor) + multi-valeurs
 * via l'op `in` + une coche **NOT** au leaf qui inverse via `node.negate`
 * (cf #504 schema-level, engine `evaluateExpression`).
 *
 * Layout d'un block :
 *   [☐NOT] [icon] [field-picker]                 [×]
 *          [op-picker]  [value widget]
 *
 * - Champs free-text + autocomplete (project / by_agent / tag_added / scope_consumer)
 *   → PrimeVue AutoComplete (single quand op=eq/neq, multiple quand op=in).
 * - Champs enum (kind / intent / priority) → Select (single) ou MultiSelect (in).
 * - Champ tags → toujours multiple (op=includes single-value, op=in multi-value).
 *
 * Garde l'accent couleur par field (border-left + tint, #477 `e8d056d`) +
 * ajoute un header icon pour distinction visuelle au scan.
 */
import { computed, inject, ref } from "vue";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import MultiSelect from "primevue/multiselect";
import AutoComplete from "primevue/autocomplete";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import type {
    ConditionField,
    ConditionOp,
    ConditionTree,
} from "../../lib/api";
import { LEAF_SOURCES_KEY, type LeafSources } from "../../lib/leaf-sources";

const props = defineProps<{
    node: ConditionTree & { kind: "leaf" };
}>();
const emit = defineEmits<{
    (e: "update", node: ConditionTree): void;
    (e: "remove"): void;
}>();

const sources = inject<LeafSources | null>(LEAF_SOURCES_KEY, null);

// --- catalogues ------------------------------------------------------------

const fieldOptions: { label: string; value: ConditionField; icon: string }[] = [
    { label: "project",        value: "project",        icon: "pi pi-folder" },
    { label: "kind",           value: "kind",           icon: "pi pi-bookmark" },
    { label: "by_agent",       value: "by_agent",       icon: "pi pi-user" },
    { label: "intent",         value: "intent",         icon: "pi pi-comment" },
    { label: "priority",       value: "priority",       icon: "pi pi-flag" },
    { label: "tags (any-of)",  value: "tags",           icon: "pi pi-tags" },
    { label: "tag_added",      value: "tag_added",      icon: "pi pi-plus-circle" },
    { label: "scope_consumer", value: "scope_consumer", icon: "pi pi-id-card" },
];
const fieldIcon = computed<string>(() =>
    fieldOptions.find((f) => f.value === props.node.field)?.icon ?? "pi pi-bolt",
);

// Le set d'ops dépend du field. Pour les enums et autocomplete on offre =,≠,∈ ;
// pour `tags` (array natif côté event) on offre ⊇ et ∈.
const opOptionsStandard: { label: string; value: ConditionOp }[] = [
    { label: "=",  value: "eq" },
    { label: "≠",  value: "neq" },
    { label: "∈ (in)",  value: "in" },
];
const opOptionsTags: { label: string; value: ConditionOp }[] = [
    { label: "⊇ (carries)", value: "includes" },
    { label: "∈ (in list)", value: "in" },
];
const opOptions = computed<{ label: string; value: ConditionOp }[]>(() => {
    if (props.node.field === "tags") return opOptionsTags;
    return opOptionsStandard;
});

const kindOptions = [
    { label: "ticket_created", value: "ticket_created" },
    { label: "comment_added",  value: "comment_added" },
    { label: "ticket_closed",  value: "ticket_closed" },
];
const intentOptions = [
    { label: "panic",    value: "panic" },
    { label: "request",  value: "request" },
    { label: "question", value: "question" },
    { label: "fyi",      value: "fyi" },
];
const priorityOptions = [
    { label: "urgent", value: "urgent" },
    { label: "high",   value: "high" },
    { label: "normal", value: "normal" },
    { label: "low",    value: "low" },
];

// --- helpers value <-> widget ---------------------------------------------

const isMulti = computed<boolean>(() => props.node.op === "in");
const isEnum = computed<boolean>(() =>
    props.node.field === "kind"
    || props.node.field === "intent"
    || props.node.field === "priority",
);
const isAutocomplete = computed<boolean>(() =>
    props.node.field === "project"
    || props.node.field === "by_agent"
    || props.node.field === "tag_added"
    || props.node.field === "scope_consumer",
);
const isTags = computed(() => props.node.field === "tags");

function enumOptionsFor(field: ConditionField): { label: string; value: string }[] {
    if (field === "kind") return kindOptions;
    if (field === "intent") return intentOptions;
    if (field === "priority") return priorityOptions;
    return [];
}

function sourceFor(field: ConditionField): string[] {
    if (!sources) return [];
    if (field === "project") return sources.projects.value;
    if (field === "by_agent") return sources.agents.value;
    if (field === "tags" || field === "tag_added") return sources.tags.value;
    if (field === "scope_consumer") return sources.consumers.value;
    return [];
}

// AutoComplete dispose d'un buffer local de suggestions filtrées par le query
// in-flight de l'utilisateur. On le repopule sur demande (`@complete`) depuis
// la source statique. Map field → buffer.
const acSuggestions = computed<string[]>(() => sourceFor(props.node.field));
const acFiltered = ref<string[]>([]);
function onAcComplete(e: { query: string }) {
    const q = (e.query ?? "").trim().toLowerCase();
    const all = acSuggestions.value;
    if (!q) acFiltered.value = all.slice(0, 50);
    else acFiltered.value = all.filter((s) => s.toLowerCase().includes(q)).slice(0, 50);
}

// Valeur normalisée vers chaîne (single) ou tableau (in/includes ambigu).
const valueSingle = computed<string>(() => {
    const v = props.node.value;
    if (v == null) return "";
    if (Array.isArray(v)) return v.join(",");
    return String(v);
});
const valueArray = computed<string[]>(() => {
    const v = props.node.value;
    if (Array.isArray(v)) return v.map((x) => String(x));
    if (v == null || v === "") return [];
    return [String(v)];
});

// --- emit helpers ----------------------------------------------------------

function emitPatch(patch: Partial<ConditionTree & { kind: "leaf" }>) {
    emit("update", { ...props.node, ...patch });
}

function setField(field: ConditionField) {
    // Reset op + value selon le nouveau type. Préserve `negate` pour ne pas
    // surprendre l'utilisateur qui vient de cocher NOT puis change le field.
    const next: ConditionTree = {
        kind: "leaf",
        field,
        op: field === "tags" ? "includes" : "eq",
        value: field === "tags" ? [] : "",
        ...(props.node.negate ? { negate: true } : {}),
    };
    emit("update", next);
}

function setOp(op: ConditionOp) {
    // Bascule single↔multi : on convertit la value (string ↔ array) au passage
    // pour ne pas la perdre / pour donner un état initial cohérent.
    const goingMulti = op === "in" || (op === "includes" && Array.isArray(props.node.value) === false && isTags.value === false);
    if (goingMulti && !Array.isArray(props.node.value)) {
        const seed = String(props.node.value ?? "").trim();
        emit("update", { ...props.node, op, value: seed ? [seed] : [] });
        return;
    }
    if (!goingMulti && Array.isArray(props.node.value)) {
        emit("update", { ...props.node, op, value: props.node.value[0] ?? "" });
        return;
    }
    emit("update", { ...props.node, op });
}

function setValueSingle(v: string | undefined) {
    emitPatch({ value: v ?? "" });
}
function setValueMulti(v: string[] | undefined) {
    emitPatch({ value: v ?? [] });
}

function setNegate(v: boolean) {
    // On omet la clé quand false pour garder la wire-shape minimale (validator
    // côté daemon strippe les junk de toute façon).
    if (v) emitPatch({ negate: true });
    else {
        const next = { ...props.node };
        delete (next as { negate?: boolean }).negate;
        emit("update", next);
    }
}
</script>

<template>
    <div
        class="leaf-block"
        :class="[`leaf-block--${node.field}`, { 'leaf-block--negated': node.negate }]"
    >
        <!-- En-tête : toggle NOT + icon + field-picker + remove × -->
        <div class="leaf-block__head">
            <label class="leaf-block__not" :title="node.negate ? 'Negation active (matches when the condition is false)' : 'Negate this condition'">
                <ToggleSwitch
                    :model-value="!!node.negate"
                    size="small"
                    @update:model-value="setNegate"
                />
                <span class="leaf-block__not-label" :class="{ 'leaf-block__not-label--active': node.negate }">NOT</span>
            </label>
            <i class="leaf-block__icon" :class="fieldIcon" />
            <Select
                :model-value="node.field"
                :options="fieldOptions"
                option-label="label"
                option-value="value"
                class="leaf-block__field"
                @update:model-value="setField"
            />
            <Button
                icon="pi pi-times"
                text
                rounded
                size="small"
                severity="secondary"
                class="leaf-block__remove"
                title="Remove this condition"
                @click="emit('remove')"
            />
        </div>

        <!-- Corps : op-picker + value widget (per-field) -->
        <div class="leaf-block__body">
            <Select
                :model-value="node.op"
                :options="opOptions"
                option-label="label"
                option-value="value"
                class="leaf-block__op"
                @update:model-value="setOp"
            />

            <!-- enum mono -->
            <Select
                v-if="isEnum && !isMulti"
                :model-value="valueSingle"
                :options="enumOptionsFor(node.field)"
                option-label="label"
                option-value="value"
                class="leaf-block__value"
                @update:model-value="setValueSingle"
            />
            <!-- enum multi -->
            <MultiSelect
                v-else-if="isEnum && isMulti"
                :model-value="valueArray"
                :options="enumOptionsFor(node.field)"
                option-label="label"
                option-value="value"
                display="chip"
                class="leaf-block__value"
                @update:model-value="setValueMulti"
            />
            <!-- autocomplete mono -->
            <AutoComplete
                v-else-if="isAutocomplete && !isMulti"
                :model-value="valueSingle"
                :suggestions="acFiltered"
                :placeholder="`pick a ${node.field}`"
                dropdown
                class="leaf-block__value"
                @complete="onAcComplete"
                @update:model-value="setValueSingle"
            />
            <!-- autocomplete multi -->
            <AutoComplete
                v-else-if="isAutocomplete && isMulti"
                :model-value="valueArray"
                :suggestions="acFiltered"
                :placeholder="`pick ${node.field}s`"
                multiple
                dropdown
                class="leaf-block__value"
                @complete="onAcComplete"
                @update:model-value="setValueMulti"
            />
            <!-- tags : op `includes` = single tag carried, `in` = multi-tag list -->
            <AutoComplete
                v-else-if="isTags && node.op === 'includes'"
                :model-value="valueSingle"
                :suggestions="acFiltered"
                placeholder="pick a tag"
                dropdown
                class="leaf-block__value"
                @complete="onAcComplete"
                @update:model-value="setValueSingle"
            />
            <AutoComplete
                v-else-if="isTags"
                :model-value="valueArray"
                :suggestions="acFiltered"
                placeholder="pick tags"
                multiple
                dropdown
                class="leaf-block__value"
                @complete="onAcComplete"
                @update:model-value="setValueMulti"
            />
            <!-- fallback : free-text -->
            <InputText
                v-else
                :model-value="valueSingle"
                placeholder="(value)"
                class="leaf-block__value"
                @update:model-value="setValueSingle"
            />
        </div>
    </div>
</template>

<style scoped>
.leaf-block {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--p-content-border-color);
    --leaf-accent: var(--p-cyan-500);
    border-left: 3px solid var(--leaf-accent);
    border-radius: 0.4rem;
    background: color-mix(in srgb, var(--leaf-accent) 4%, var(--p-content-background, transparent));
}
.leaf-block--project        { --leaf-accent: var(--p-cyan-500); }
.leaf-block--kind           { --leaf-accent: var(--p-purple-500); }
.leaf-block--by_agent       { --leaf-accent: var(--p-pink-500); }
.leaf-block--intent         { --leaf-accent: var(--p-indigo-500); }
.leaf-block--priority       { --leaf-accent: var(--p-orange-500); }
.leaf-block--tags           { --leaf-accent: var(--p-teal-500); }
.leaf-block--tag_added      { --leaf-accent: var(--p-emerald-500); }
.leaf-block--scope_consumer { --leaf-accent: var(--p-rose-500); }

/* État "négué" : on accentue par un cadre dashed rouge léger + un fond
   un peu plus mat pour signaler que le sens du leaf est inversé. */
.leaf-block--negated {
    border-style: dashed;
    border-color: var(--p-red-400);
    background: color-mix(in srgb, var(--p-red-500) 5%, var(--p-content-background, transparent));
}

.leaf-block__head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
}
.leaf-block__not {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    cursor: pointer;
    user-select: none;
}
.leaf-block__not-label {
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--p-text-muted-color);
    letter-spacing: 0.05em;
}
.leaf-block__not-label--active {
    color: var(--p-red-500);
}
.leaf-block__icon {
    color: var(--leaf-accent);
    font-size: 1rem;
}
.leaf-block__field {
    min-width: 11rem;
}
.leaf-block__remove {
    margin-left: auto;
}

.leaf-block__body {
    display: grid;
    grid-template-columns: minmax(6rem, auto) 1fr;
    gap: 0.4rem;
    align-items: center;
    padding-left: 0.2rem;
}
.leaf-block__op {
    min-width: 5.5rem;
}
.leaf-block__value {
    min-width: 0;
    width: 100%;
}
</style>
