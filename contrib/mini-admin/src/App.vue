<script setup lang="ts">
import PanelHeader from "@kit/PanelHeader.vue";
</script>

<template>
    <!-- No `.aiball-main` here on purpose: the kit documents it as the level-1
         container, but it is defined inside the frontend's App.vue, not in the
         shared stylesheet — so it does not exist outside that app. See
         docs/UI-KIT.md, step 1. -->
    <main class="demo-main">
        <PanelHeader title="Widgets">
            <p class="aiball-explainer aiball-explainer--muted">
                Step 1 — the stack boots and one kit component renders.
            </p>
        </PanelHeader>
    </main>
</template>

<style>
/* The demo has to invent its own page container. `.aiball-main` would be the
   documented one, but it is not reachable from outside the frontend app. */
.demo-main {
    max-width: 980px;
    margin: 0 auto;
    padding: 1rem;
}
</style>
