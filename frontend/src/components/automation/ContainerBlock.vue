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
        // david (#498 + #477 `4eb8gf`) : un NOT créé vient sans contenu
        // visible. Le placeholder AND vide reste pour satisfaire le schéma
        // (`not.child` requis côté validateConditionTree), mais il est rendu
        // comme "rien" + un +Add interne où l'utilisateur choisit lui-même
        // sa sous-condition (Condition / Group AND / Group OR).
        command: () => addChild({ kind: "not", child: { kind: "and", children: [] } }),
    },
];

// david `4eb8gf` : "rien dans le NOT" + "je dois pouvoir choisir la
// sous-condition que je veux". On garde le placeholder dans la data (schéma
// `not.child` requis) mais on le rend invisible et on remplace le ConditionNode
// récursif par un menu +Add à 3 options. L'utilisateur compose à sa main.
function isNotPlaceholder(child: ConditionTree): boolean {
    return child.kind === "and" && child.children.length === 0;
}
const notIsEmpty = computed(() => props.node.kind === "not" && isNotPlaceholder(props.node.child));

const notAddMenu = ref();
const notAddMenuItems = [
    {
        label: "Condition",
        icon: "pi pi-bolt",
        command: () => emit("update", { kind: "not", child: blankLeaf() }),
    },
    {
        label: "Group : ALL of (AND)",
        icon: "pi pi-th-large",
        command: () => emit("update", { kind: "not", child: { kind: "and", children: [blankLeaf()] } }),
    },
    {
        label: "Group : ANY of (OR)",
        icon: "pi pi-th-large",
        command: () => emit("update", { kind: "not", child: { kind: "or", children: [blankLeaf()] } }),
    },
    // Pas de NOT-dans-NOT — c'est une double négation peu lisible. Si besoin
    // l'utilisateur peut toujours basculer via l'éditeur Code.
];
function openNotAddMenu(event: Event) {
    notAddMenu.value?.toggle(event);
}

function blankLeaf(): ConditionTree {
    // Default leaf : project + op `in` + value [] (#522 david `bhc88v` :
    // tous les fields ont migré sur op:in array-style ; `op:eq value:""`
    // était stale post-#522). Empty array = leaf qui matche rien (vacuous
    // false jusqu'à ce que l'utilisateur ajoute des chips) — sémantique
    // claire vs un literal empty string. project = field le plus utile
    // comme starting point, l'utilisateur switch facilement via le picker.
    const field: ConditionField = "project";
    return { kind: "leaf", field, op: "in", value: [] };
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
        // #477 + #498 : NOT garde toujours un child non-vide (le schéma
        // l'exige) MAIS on refill avec un AND vide plutôt qu'un leaf —
        // cohérent avec la création initiale d'un NOT (#498). Le NOT
        // ne morphe pas en AND/OR : il reste un NOT autour d'un AND
        // vide, que l'utilisateur peut basculer en OR ou remplir.
        emit("update", { kind: "not", child: { kind: "and", children: [] } });
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
                <!-- david `4eb8gf` : NOT vide affiche rien + un +Add interne ;
                     dès qu'un child réel est posé on retombe sur ConditionNode. -->
                <ConditionNode
                    v-if="node.kind === 'not' && !notIsEmpty"
                    :node="node.child"
                    @update="(c) => updateChild(0, c)"
                    @remove="removeChild(0)"
                />
                <div v-else class="container-block__empty">
                    <em>(empty — pick a sub-condition to negate)</em>
                </div>
            </template>
            <template v-else-if="node.kind !== 'not'">
                <ConditionNode
                    v-for="(c, i) in node.children"
                    :key="i"
                    :node="c"
                    @update="(child) => updateChild(i, child)"
                    @remove="removeChild(i)"
                />
                <!-- #525 david — un container vide est licit. Sémantique :
                     AND vide = vacuous true (matches everything) ; OR vide =
                     vacuous false (matches nothing). On le dit explicitement
                     pour qu'on sache que ne rien poser est un choix valide,
                     pas une étape incomplète. -->
                <div v-if="node.children.length === 0" class="container-block__empty">
                    <em v-if="node.kind === 'and'">(empty AND — matches everything by default)</em>
                    <em v-else-if="node.kind === 'or'">(empty OR — matches nothing — add a branch or switch to AND)</em>
                    <em v-else>(empty — add a condition)</em>
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
        <div v-else-if="notIsEmpty" class="container-block__add">
            <Button
                icon="pi pi-plus"
                label="add condition to negate"
                text
                size="small"
                @click="openNotAddMenu"
            />
            <Menu ref="notAddMenu" :model="notAddMenuItems" :popup="true" />
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
