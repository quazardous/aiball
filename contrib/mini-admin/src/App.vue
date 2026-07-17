<script setup lang="ts">
import WidgetsList from "./WidgetsList.vue";
import WidgetDetail from "./WidgetDetail.vue";
import { role, type Role } from "./session";
import { currentMatch, currentPath, menu, navigate } from "./router";

// Step 3 reopened this file: the role has to be switchable to demo the gate,
// and there is nowhere else to put the switch. The kit has no app shell, no
// header slot, no identity surface — App.vue in the frontend owns all of that
// privately, so a second app rebuilds it.
const ROLES: Role[] = ["viewer", "editor"];

// Step 4 reopened it again: the nav menu has no kit component either. The
// frontend's own menu lives inside its App.vue, non-scoped and unexported —
// the same shape as `.aiball-main`. Reachable to read, impossible to reuse.
</script>

<template>
    <!-- No `.aiball-main` here on purpose: the kit documents it as the level-1
         container, but it is defined inside the frontend's App.vue, not in the
         shared stylesheet — so it does not exist outside that app. See
         docs/UI-KIT.md, step 1. -->
    <main class="demo-main">
        <div class="demo-topbar">
            <nav class="demo-nav">
                <a
                    v-for="item in menu"
                    :key="item.path"
                    class="demo-nav__item"
                    :class="{ 'is-active': currentPath === item.path }"
                    :href="`#${item.path}`"
                >{{ item.label }}</a>
            </nav>

            <div class="demo-session">
                <label class="field-label" for="demo-role">signed in as</label>
                <Select id="demo-role" v-model="role" :options="ROLES" size="small" />
            </div>
        </div>

        <WidgetDetail
            v-if="currentMatch?.route.path === '/widgets/:id'"
            :id="currentMatch.params.id"
            @close="navigate('/widgets')"
        />
        <WidgetsList
            v-else-if="currentMatch?.route.path === '/widgets'"
            @open="(id) => navigate(`/widgets/${id}`)"
        />
        <p v-else class="aiball-explainer">
            A mini admin built with the aiball UI kit — see
            <code>docs/UI-KIT.md</code>. Open <a href="#/widgets">Widgets</a>.
        </p>
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
.demo-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.75rem;
}
/* No kit component for a nav, so the demo styles its own from scratch. */
.demo-nav {
    display: flex;
    gap: 0.75rem;
}
.demo-nav__item {
    color: var(--p-text-muted-color);
    text-decoration: none;
    font-size: var(--fs-sm);
}
.demo-nav__item.is-active {
    color: var(--p-primary-color);
    font-weight: 600;
}
.demo-session {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}
</style>
