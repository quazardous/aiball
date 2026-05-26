<script setup lang="ts">
/**
 * #457 slice 5.3b — container block : AND / OR (N children) or NOT (single
 * child). Recurses via `<ConditionNode>` which dispatches back here for
 * nested containers.
 *
 * Affordances :
 *   - Toggle between AND / OR via a Select at the top — preserves children.
 *   - "+ Add condition" / "+ Add group (AND / OR / NOT)" via a Menu — drops
 *     a fresh blank node into `children`.
 *   - Each child has its own × via `<ConditionNode>`.
 *   - The root container can't be removed (the parent passes a different
 *     `removable: false` prop) ; nested containers can be.
 *
 * NOT is rendered specially : it has a single `child` (not an array). The
 * UI shows it as a single nested node with a "negate" label band.
 */
import { computed, ref } from "vue";
import Select from "primevue/select";
import Button from "primevue/button";
import Menu from "primevue/menu";
import type { ConditionField, ConditionTree } from "../../lib/api";
import ConditionNode from "./ConditionNode.vue";

const props = defineProps<{
    node: Exclude<ConditionTree, { kind: "leaf" }>;
    /** Root container at the top of the editor can't be removed. */
    removable?: boolean;
}>();
const emit = defineEmits<{
    (e: "update", node: ConditionTree): void;
    (e: "remove"): void;
}>();

const kindOptions = [
    { label: "ALL of (AND)", value: "and" },
    { label: "ANY of (OR)", value: "or" },
];

const addMenu = ref();
const addMenuItems = [
    {
        label: "Condition",
        icon: "pi pi-bolt",
        command: () => addChild(blankLeaf()),
    },
    {
        label: "Group : ALL of (AND)",
        icon: "pi pi-th-large",
        command: () => addChild({ kind: "and", children: [blankLeaf()] }),
    },
    {
        label: "Group : ANY of (OR)",
        icon: "pi pi-th-large",
        command: () => addChild({ kind: "or", children: [blankLeaf()] }),
    },
    {
        label: "Group : NOT",
        icon: "pi pi-ban",
        command: () => addChild({ kind: "not", child: blankLeaf() }),
    },
];

function blankLeaf(): ConditionTree {
    // Default leaf : project = "" (empty string ; the user will type or
    // switch field). A `tags` leaf would default to [] — but project is the
    // most-used so it's a sensible starting field.
    const field: ConditionField = "project";
    return { kind: "leaf", field, op: "eq", value: "" };
}

const isNot = computed(() => props.node.kind === "not");

function setKind(newKind: "and" | "or") {
    if (props.node.kind === "not") return; // NOT toggles via its own UI
    emit("update", { kind: newKind, children: props.node.children });
}

function addChild(child: ConditionTree) {
    if (props.node.kind === "not") {
        // NOT only has one slot — replace it.
        emit("update", { kind: "not", child });
        return;
    }
    emit("update", {
        kind: props.node.kind,
        children: [...props.node.children, child],
    });
}

function updateChild(index: number, child: ConditionTree) {
    if (props.node.kind === "not") {
        emit("update", { kind: "not", child });
        return;
    }
    const next = [...props.node.children];
    next[index] = child;
    emit("update", { kind: props.node.kind, children: next });
}

function removeChild(index: number) {
    if (props.node.kind === "not") {
        // #477 david : "si je choisit NOT, il vient avec une condition
        // projet. si je supprime la condition projet, le Not se
        // transforme en AND/OR". On collapse-ait en `{kind:"and",
        // children:[]}` ce qui MORPHAIT le NOT en AND vide → bug.
        // Maintenant on garde le NOT vivant en remettant un leaf blank
        // (même default que la root-picker quand on choisit NOT) ;
        // l'utilisateur peut éditer ce leaf ou supprimer le NOT entier
        // via le × propre au container NOT.
        emit("update", { kind: "not", child: blankLeaf() });
        return;
    }
    const next = props.node.children.filter((_, i) => i !== index);
    if (next.length === 0) {
        // Empty AND/OR is degenerate ; ask the parent to remove the whole
        // container unless we're at the root (parent decides via `removable`).
        if (props.removable) {
            emit("remove");
            return;
        }
        // At the root : keep the container but with no children. The
        // top-level RuleEditor treats `and:[]` as "match anything", so this
        // is a valid resting state.
    }
    emit("update", { kind: props.node.kind, children: next });
}

function openAddMenu(event: Event) {
    addMenu.value?.toggle(event);
}
</script>

<template>
    <div class="container-block" :class="`container-block--${node.kind}`">
        <div class="container-block__head">
            <template v-if="isNot">
                <span class="container-block__not-label">
                    <i class="pi pi-ban" /> NOT
                </span>
            </template>
            <template v-else>
                <Select
                    :model-value="node.kind"
                    :options="kindOptions"
                    option-label="label"
                    option-value="value"
                    class="container-block__kind"
                    @update:model-value="setKind"
                />
            </template>
            <Button
                v-if="removable"
                icon="pi pi-times"
                text
                rounded
                size="small"
                severity="secondary"
                class="container-block__remove"
                :title="`Remove this group`"
                @click="emit('remove')"
            />
        </div>

        <div class="container-block__children">
            <template v-if="isNot">
                <ConditionNode
                    v-if="node.kind === 'not'"
                    :node="node.child"
                    @update="(c) => updateChild(0, c)"
                    @remove="removeChild(0)"
                />
            </template>
            <template v-else-if="node.kind !== 'not'">
                <ConditionNode
                    v-for="(c, i) in node.children"
                    :key="i"
                    :node="c"
                    @update="(child) => updateChild(i, child)"
                    @remove="removeChild(i)"
                />
                <div v-if="node.children.length === 0" class="container-block__empty">
                    <em>(empty — add a condition to make this group match anything)</em>
                </div>
            </template>
        </div>

        <div v-if="!isNot" class="container-block__add">
            <Button
                icon="pi pi-plus"
                label="add"
                text
                size="small"
                @click="openAddMenu"
            />
            <Menu ref="addMenu" :model="addMenuItems" :popup="true" />
        </div>
    </div>
</template>

<style scoped>
.container-block {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.4rem;
}
.container-block--and {
    border-left: 3px solid var(--p-blue-500);
    background: color-mix(in srgb, var(--p-blue-500) 3%, var(--p-content-background, transparent));
}
.container-block--or {
    border-left: 3px solid var(--p-amber-500);
    background: color-mix(in srgb, var(--p-amber-500) 3%, var(--p-content-background, transparent));
}
.container-block--not {
    border-left: 3px solid var(--p-red-500);
    background: color-mix(in srgb, var(--p-red-500) 3%, var(--p-content-background, transparent));
}
.container-block__head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}
.container-block__kind {
    min-width: 10rem;
}
.container-block__not-label {
    font-family: ui-monospace, monospace;
    font-weight: 600;
    color: var(--p-red-600);
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
}
.container-block__remove {
    margin-left: auto;
}
.container-block__children {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding-left: 0.4rem;
}
.container-block__empty {
    color: var(--p-text-muted-color);
    font-size: 0.85rem;
    padding: 0.3rem 0;
}
.container-block__add {
    padding-left: 0.4rem;
}
</style>
