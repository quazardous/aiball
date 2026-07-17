<script setup lang="ts">
import { ref } from "vue";
import WidgetsList from "./WidgetsList.vue";
import WidgetDetail from "./WidgetDetail.vue";

// Step 2 needs no router: one ref is enough to swap list ↔ detail. Real
// navigation (URL, menu, breadcrumb) is step 4 — that is where the demo finds
// out what the frontend's router really costs.
const openId = ref<string | null>(null);
</script>

<template>
    <!-- No `.aiball-main` here on purpose: the kit documents it as the level-1
         container, but it is defined inside the frontend's App.vue, not in the
         shared stylesheet — so it does not exist outside that app. See
         docs/UI-KIT.md, step 1. -->
    <main class="demo-main">
        <WidgetDetail
            v-if="openId"
            :id="openId"
            @close="openId = null"
        />
        <WidgetsList v-else @open="(id) => (openId = id)" />
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
