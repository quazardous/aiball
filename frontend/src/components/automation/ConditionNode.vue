<script setup lang="ts">
/**
 * #457 slice 5.3b — recursive dispatcher for the condition tree editor.
 *
 * One tree node = one rendered component. Dispatches on `node.kind` :
 *   - `leaf` → `<ConditionLeafBlock>` (field+op+value inputs).
 *   - `and` | `or` → `<ContainerBlock>` (N children + "+ add" menu).
 *   - `not` → wraps a single child + a "replace by an empty AND" affordance
 *      (we don't expose deep NOT editing today — keep it shallow).
 *
 * Emits up :
 *   - `update` : the rebuilt node (any change anywhere in its subtree).
 *   - `remove` : ask the parent to drop this node from its `children`.
 *
 * Cyclic import note : `ContainerBlock` imports `ConditionNode` (and vice
 * versa) — Vue's `defineComponent` + `<script setup>` handle this fine as
 * long as the imports are top-level (no runtime eval at module init).
 */
import type { ConditionTree } from "../../lib/api";
import ConditionLeafBlock from "./ConditionLeafBlock.vue";
import ContainerBlock from "./ContainerBlock.vue";

defineProps<{
    node: ConditionTree;
}>();
const emit = defineEmits<{
    (e: "update", node: ConditionTree): void;
    (e: "remove"): void;
}>();
</script>

<template>
    <ConditionLeafBlock
        v-if="node.kind === 'leaf'"
        :node="node"
        @update="(n) => emit('update', n)"
        @remove="emit('remove')"
    />
    <!-- david `3cncqt` : les × n'apparaissaient pas sur les containers
         nestés parce que ConditionNode ne passait pas `removable` →
         ContainerBlock défaultait à `false` partout sauf à la root où
         RuleEditor le passait explicitement. Ici on l'active : par
         construction tout container atteint via ConditionNode est un
         ENFANT (la root est rendue directement par RuleEditor sans
         passer par ConditionNode). -->
    <ContainerBlock
        v-else
        :node="node"
        :removable="true"
        @update="(n) => emit('update', n)"
        @remove="emit('remove')"
    />
</template>
