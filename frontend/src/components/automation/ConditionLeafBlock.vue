<script setup lang="ts">
/**
 * #504 — leaf condition block, retravaillé : widgets spécialisés par field +
 * autocomplete (via `leaf-sources` injecté par RuleEditor) + multi-valeurs via
 * l'op `in` + une coche **NOT** au leaf (david `7yvf5f` q1=sugar : la coche
 * NE modifie PAS le data du leaf ; elle remonte à `ConditionNode` qui
 * wrap/unwrap en `{kind:"not", child:leaf}` côté tree — schema inchangé).
 *
 * Layout d'un block :
 *   [☐NOT] [icon] [field-picker]                 [×]
 *          [op-picker]  [value widget (chips ou autocomplete)]
 *
 * Widgets, selon la *population* du field (david `7yvf5f` : "la forme peut être
 * adaptée à la population") :
 *  - enums (kind/intent/priority — 3-4 valeurs) → chip row à cliquer (toggle
 *    quand multi, sélection exclusive quand single), pattern TagPicker.
 *  - listes longues (project/by_agent/tag_added/scope_consumer/tags) →
 *    AutoComplete (single ou multiple selon l'op).
 *
 * Accents couleurs par field préservés (#477 `e8d056d`, david `7yvf5f` q3 =
 * inclus dans la supersede).
 */
import { computed, inject, ref } from "vue";
import Select from "primevue/select";
import AutoComplete from "primevue/autocomplete";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import type {
    ConditionField,
    ConditionOp,
    ConditionTree,
    Tag,
} from "../../lib/api";
import { LEAF_SOURCES_KEY, type LeafSources } from "../../lib/leaf-sources";
import TagBadge from "../TagBadge.vue";

const props = defineProps<{
    node: ConditionTree & { kind: "leaf" };
    /** #504 UI-sugar : true quand le tree est `{not:{leaf}}`. La coche NOT du
     *  leaf émet `update:negate` ; le wrap/unwrap se fait côté ConditionNode. */
    negate?: boolean;
}>();
const emit = defineEmits<{
    (e: "update", node: ConditionTree): void;
    (e: "update:negate", value: boolean): void;
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

const opOptionsStandard: { label: string; value: ConditionOp }[] = [
    { label: "=",  value: "eq" },
    { label: "≠",  value: "neq" },
    { label: "∈ (in)",  value: "in" },
];
// #504 david `b8x54s` : pour `tags` on cache le op picker — `carries` (1 tag)
// et `in list` (N tags) sont équivalents quand on en pose un seul. Le moteur
// (`engine.ts` case "in") couvre maintenant la sémantique "any-of" sur un
// field array, donc on force `op=in` et le chip row multi fait le reste.
const opOptions = computed<{ label: string; value: ConditionOp }[]>(() => opOptionsStandard);
const hideOpPicker = computed(() => props.node.field === "tags");

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
// #504 `ftj93r` : tags + tag_added utilisent un chip row de TagBadge, comme la
// création de ticket — population bornée + colorée. Pas d'AutoComplete pour
// ces deux-là (l'AutoComplete reste pour les listes textuelles ouvertes).
const isTagField = computed(() =>
    props.node.field === "tags" || props.node.field === "tag_added",
);
const isAutocomplete = computed<boolean>(() =>
    props.node.field === "project"
    || props.node.field === "by_agent"
    || props.node.field === "scope_consumer",
);

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

const acSuggestions = computed<string[]>(() => sourceFor(props.node.field));
const acFiltered = ref<string[]>([]);

// #504 `ftj93r` : tags / tag_added → chip row de TagBadge, populé depuis le
// catalogue (avec couleurs). On lit `sources.tagObjects` (Tag[]) plutôt que
// `sources.tags` (string[]) pour avoir les colors.
const tagBadgeOptions = computed<Tag[]>(() => sources?.tagObjects.value ?? []);
function onAcComplete(e: { query: string }) {
    const q = (e.query ?? "").trim().toLowerCase();
    const all = acSuggestions.value;
    if (!q) acFiltered.value = all.slice(0, 50);
    else acFiltered.value = all.filter((s) => s.toLowerCase().includes(q)).slice(0, 50);
}

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

// --- chip helpers (enum click-chips, david `7yvf5f` "tags à cliquer") ----

function isChipSelected(opt: string): boolean {
    if (isMulti.value) return valueArray.value.includes(opt);
    return valueSingle.value === opt;
}
function toggleChip(opt: string) {
    if (isMulti.value) {
        const cur = new Set(valueArray.value);
        if (cur.has(opt)) cur.delete(opt);
        else cur.add(opt);
        emitPatch({ value: [...cur] });
    } else {
        // Single-select : clic = sélectionne (re-cliquer ne désélectionne pas
        // pour éviter "value vide" silencieux ; passer par × pour supprimer).
        emitPatch({ value: opt });
    }
}

// --- emit helpers ----------------------------------------------------------

function emitPatch(patch: Partial<ConditionTree & { kind: "leaf" }>) {
    emit("update", { ...props.node, ...patch });
}

function setField(field: ConditionField) {
    // #504 `b8x54s` : pour `tags`, défaut op = `in` (any-of), value = array.
    // Le chip row multi-toggle gère la suite ; le op picker est caché.
    const next: ConditionTree = {
        kind: "leaf",
        field,
        op: field === "tags" ? "in" : "eq",
        value: field === "tags" ? [] : "",
    };
    emit("update", next);
}

function setOp(op: ConditionOp) {
    const goingMulti = op === "in";
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
    emit("update:negate", v);
}
</script>

<template>
    <div
        class="leaf-block"
        :class="[`leaf-block--${node.field}`, { 'leaf-block--negated': negate }]"
    >
        <!-- En-tête : toggle NOT + icon + field-picker + remove × -->
        <div class="leaf-block__head">
            <label class="leaf-block__not" :title="negate ? 'Negation active (matches when the condition is false)' : 'Negate this condition'">
                <ToggleSwitch
                    :model-value="!!negate"
                    size="small"
                    @update:model-value="setNegate"
                />
                <span class="leaf-block__not-label" :class="{ 'leaf-block__not-label--active': negate }">NOT</span>
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

        <!-- Corps : op-picker + value widget. Le picker est caché pour `tags`
             (only `in` makes sense, cf #504 `b8x54s`). -->
        <div class="leaf-block__body" :class="{ 'leaf-block__body--no-op': hideOpPicker }">
            <Select
                v-if="!hideOpPicker"
                :model-value="node.op"
                :options="opOptions"
                option-label="label"
                option-value="value"
                class="leaf-block__op"
                @update:model-value="setOp"
            />

            <!-- enum : chip row textuel (toggle multi / exclusif single) -->
            <div v-if="isEnum" class="leaf-block__chips">
                <button
                    v-for="opt in enumOptionsFor(node.field)"
                    :key="opt.value"
                    type="button"
                    class="leaf-chip"
                    :class="{ 'leaf-chip--selected': isChipSelected(opt.value) }"
                    @click="toggleChip(opt.value)"
                >
                    {{ opt.label }}
                </button>
            </div>
            <!-- tags / tag_added : chip row de TagBadge depuis le catalogue
                 (mêmes couleurs que TagPicker). #504 `ftj93r`. -->
            <div v-else-if="isTagField" class="leaf-block__chips">
                <button
                    v-for="t in tagBadgeOptions"
                    :key="t.name"
                    type="button"
                    class="leaf-chip leaf-chip--tag"
                    :class="{ 'leaf-chip--selected': isChipSelected(t.name) }"
                    :title="t.note ?? t.name"
                    @click="toggleChip(t.name)"
                >
                    <TagBadge :tag="t" size="sm" />
                </button>
                <span v-if="tagBadgeOptions.length === 0" class="leaf-block__empty">
                    no tags in the catalog — define some in Settings → Tags first.
                </span>
            </div>
            <!-- autocomplete mono (free-text + suggestions) -->
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
            <!-- autocomplete multi (chips PrimeVue) -->
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
            <!-- fallback : free-text. Garde un input texte pour les fields
                 sans population connue (rien en pratique aujourd'hui). -->
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
/* #504 `b8x54s` : pas de op picker pour `tags` → la 1ère colonne disparaît. */
.leaf-block__body--no-op {
    grid-template-columns: 1fr;
}
.leaf-block__op {
    min-width: 5.5rem;
}
.leaf-block__value {
    min-width: 0;
    width: 100%;
}

/* Chip row pour enums (kind / intent / priority) — pattern TagPicker
   adapté : tous les choix visibles d'un coup, click = toggle (multi) ou
   sélection exclusive (single). Couleur d'accent = celle du leaf-accent
   du field, pour rester cohérent avec la border. */
.leaf-block__chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
}
.leaf-chip {
    background: transparent;
    border: 1px solid var(--p-content-border-color);
    border-radius: 999px;
    padding: 0.15rem 0.7rem;
    font-size: 0.75rem;
    cursor: pointer;
    color: var(--p-text-muted-color);
    transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.leaf-chip:hover {
    border-color: var(--leaf-accent);
    color: var(--p-text-color);
}
.leaf-chip--selected {
    background: color-mix(in srgb, var(--leaf-accent) 22%, var(--p-content-background, transparent));
    border-color: var(--leaf-accent);
    color: var(--p-text-color);
    font-weight: 600;
}

/* #504 `3bd3jm` : pour les tags on supprime la 2e border du wrapper (le
   TagBadge a déjà sa forme/couleur), on pilote la sélection par opacité +
   ring de focus — pattern TagPicker à la création de ticket. */
.leaf-chip--tag {
    background: transparent;
    border: 1px solid transparent;
    padding: 0.1rem;
    opacity: 0.45;
}
.leaf-chip--tag:hover {
    border-color: transparent;
    opacity: 0.8;
}
.leaf-chip--tag.leaf-chip--selected {
    background: transparent;
    border-color: var(--p-primary-color);
    opacity: 1;
}
</style>
