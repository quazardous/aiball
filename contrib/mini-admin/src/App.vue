<script setup lang="ts">
import { ref } from "vue";
import WidgetsList from "./WidgetsList.vue";
import WidgetDetail from "./WidgetDetail.vue";
import { role, type Role } from "./session";

// Step 3 reopened this file: the role has to be switchable to demo the gate,
// and there is nowhere else to put the switch. The kit has no app shell, no
// header slot, no identity surface — App.vue in the frontend owns all of that
// privately, so a second app rebuilds it.
const ROLES: Role[] = ["viewer", "editor"];

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
        <div class="demo-session">
            <label class="field-label" for="demo-role">signed in as</label>
            <Select id="demo-role" v-model="role" :options="ROLES" size="small" />
        </div>

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
.demo-session {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-bottom: 0.75rem;
}
</style>
