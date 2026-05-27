<script setup lang="ts">
/**
 * #457 slice 5.3b — recursive dispatcher for the condition tree editor.
 *
 * One tree node = one rendered component. Dispatches on `node.kind` :
 *   - `leaf`                          → `<ConditionLeafBlock negate=false>`
 *   - `not` autour d'un `leaf`        → `<ConditionLeafBlock negate=true>` (#504 sugar)
 *     L'UI rend le couple {not,leaf} comme UN seul block "leaf négué" avec une
 *     coche NOT, mais la DATA reste `{kind:"not", child:leaf}` (B / UI-sugar
 *     only, david `7yvf5f` — pas de migration schema).
 *   - `and` | `or` | `not` (au-dessus de non-leaf) → `<ContainerBlock>` classique.
 *
 * Emits up :
 *   - `update` : the rebuilt node (any change anywhere in its subtree).
 *   - `remove` : ask the parent to drop this node from its `children`.
 */
import { computed } from "vue";
import type { ConditionTree } from "../../lib/api";
import ConditionLeafBlock from "./ConditionLeafBlock.vue";
import ContainerBlock from "./ContainerBlock.vue";

const props = defineProps<{
    node: ConditionTree;
}>();
const emit = defineEmits<{
    (e: "update", node: ConditionTree): void;
    (e: "remove"): void;
}>();

// #504 — détecte un "negated leaf" : un NOT direct au-dessus d'un leaf. C'est
// le seul cas où l'UI rend compactement. NOT autour d'un container reste un
// vrai container (le user veut négué un sous-arbre, on garde le NOT box).
const isNegatedLeaf = computed(() =>
    props.node.kind === "not" && props.node.child.kind === "leaf",
);
const isPlainLeaf = computed(() => props.node.kind === "leaf");
const renderedAsLeaf = computed(() => isPlainLeaf.value || isNegatedLeaf.value);
const leafForView = computed(() =>
    props.node.kind === "leaf"
        ? props.node
        : (props.node as { kind: "not"; child: ConditionTree & { kind: "leaf" } }).child,
);
// Narrowing pour ContainerBlock : tout ce qui n'est pas un leaf (et pas un
// negated-leaf, qui passe par le leaf-block). Le cast est sûr par construction
// — `renderedAsLeaf` couvre les deux formes leaf.
const containerNode = computed(() =>
    props.node as Exclude<ConditionTree, { kind: "leaf" }>,
);

function onLeafUpdate(leaf: ConditionTree) {
    // Préserve le wrap NOT côté data si on était en mode negated.
    if (isNegatedLeaf.value) emit("update", { kind: "not", child: leaf });
    else emit("update", leaf);
}
function onLeafToggleNegate(neg: boolean) {
    const leaf = leafForView.value;
    if (neg) emit("update", { kind: "not", child: leaf });
    else emit("update", leaf);
}
</script>

<template>
    <ConditionLeafBlock
        v-if="renderedAsLeaf"
        :node="leafForView"
        :negate="isNegatedLeaf"
        @update="onLeafUpdate"
        @update:negate="onLeafToggleNegate"
        @remove="emit('remove')"
    />
    <!-- david `3cncqt` : les × n'apparaissaient pas sur les containers nestés
         parce que ConditionNode ne passait pas `removable` → ContainerBlock
         défaultait à false partout sauf à la root où RuleEditor le passait
         explicitement. Ici on l'active : par construction tout container atteint
         via ConditionNode est un ENFANT (la root est rendue directement par
         RuleEditor sans passer par ConditionNode). -->
    <ContainerBlock
        v-else
        :node="containerNode"
        :removable="true"
        @update="(n) => emit('update', n)"
        @remove="emit('remove')"
    />
</template>
