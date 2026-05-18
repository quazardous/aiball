<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";

export interface ProjectListItem {
    label: string;
    value: string | null;
    icon: string;
    pending: number;
    unread: number;
    open: number;
    resolved: number;
    snoozed: number;
}

export type SettingsPanel = "rules" | "tags" | "projects" | "consumers" | "compose";

/**
 * Per-project sub-pages (#B.127): "settings" hosts the moderation
 * strategy + future admin; "stats" is read-only metrics. Entry points
 * live in Settings > Projects (ProjectsPanel rows) — sidebar receives
 * `projectPage` so the inbox item doesn't light up while a sub-page
 * is active.
 */
export type ProjectPage = "stats" | "settings";

const props = defineProps<{
    items: ProjectListItem[];
    panel: SettingsPanel | null;
    project: string | null;
    projectPage: ProjectPage | null;
}>();

const emit = defineEmits<{
    (e: "select", value: string | null): void;
    (e: "open-panel", panel: SettingsPanel): void;
    (e: "new-ticket"): void;
    (e: "open-current-settings"): void;
}>();

// #B.161: collapse the projects details by default on phones so the
// sidebar band (max-height 30vh on mobile) leaves room for the active
// project's badges + settings footer. User can still expand to pick
// another project. Tracked reactively to handle window resize.
const projectsOpen = ref(typeof window === "undefined" || window.innerWidth > 720);
function syncProjectsOpen() {
    projectsOpen.value = window.innerWidth > 720;
}
onMounted(() => window.addEventListener("resize", syncProjectsOpen));
onUnmounted(() => window.removeEventListener("resize", syncProjectsOpen));

// #B.161 follow-up: when the details is collapsed, the summary shows
// the active project so the user always knows where they are without
// expanding. Falls back to "Projects" when the list is empty.
const activeProjectLabel = computed(() => {
    const active = props.items.find((p) => p.value === props.project);
    return active?.label ?? "Projects";
});
</script>

<template>
    <aside class="aiball-sidebar">
        <!-- #B.161: projects list wrapped in <details> so it collapses
             on mobile via CSS (open by default on desktop, collapsed
             by default on phone — saves the 30vh sidebar band for the
             active project's row only). -->
        <details class="sidebar-projects" :open="projectsOpen">
            <summary class="sidebar-section-label">
                <span class="sidebar-projects__label">{{ activeProjectLabel }}</span>
                <!-- #B.161 follow-up: quick "+ new ticket" on the
                     right of the project name when projects is
                     collapsed on mobile — saves the user from
                     scrolling past the inbox toolbar. Hidden on
                     desktop (the InboxToolbar already exposes it
                     there). @click.stop so the summary toggle
                     doesn't fire. -->
                <!-- #B.169: quick-access cog to the current project's
                     settings page — shorter route than the "strategy:
                     project settings →" hint that was the only entry
                     point before. Visible only when a specific
                     project is selected (the link makes no sense in
                     "All projects" mode). -->
                <button
                    v-if="project"
                    type="button"
                    class="sidebar-project-settings"
                    title="Project settings"
                    @click.stop="emit('open-current-settings')"
                >
                    <i class="pi pi-cog" />
                </button>
                <button
                    type="button"
                    class="sidebar-new-ticket"
                    title="New ticket"
                    @click.stop="emit('new-ticket')"
                >
                    <i class="pi pi-plus" />
                </button>
            </summary>
            <button
                v-for="p in items"
                :key="p.value ?? '__all__'"
                type="button"
                class="sidebar-item"
                :class="{ active: panel === null && projectPage === null && project === p.value }"
                @click="emit('select', p.value)"
            >
                <i :class="p.icon" />
                <span class="sidebar-item-label">{{ p.label }}</span>
                <span
                    v-if="p.pending > 0"
                    class="sidebar-badge sidebar-badge--pending"
                    :title="`${p.pending} pending moderation`"
                >{{ p.pending }}</span>
                <span
                    v-if="p.resolved > 0"
                    class="sidebar-badge sidebar-badge--resolved"
                    :title="`${p.resolved} resolution proposal${p.resolved > 1 ? 's' : ''} waiting for your accept/reject`"
                >{{ p.resolved }}</span>
                <span
                    v-if="p.unread > 0"
                    class="sidebar-badge sidebar-badge--unread"
                    :title="`${p.unread} unread tickets for you`"
                >{{ p.unread }}</span>
                <span
                    v-if="p.open > 0"
                    class="sidebar-badge sidebar-badge--open"
                    :title="`${p.open} open tickets`"
                >{{ p.open }}</span>
            </button>
        </details>

        <!-- Settings — visually pushed to the bottom on mobile via
             margin-top: auto so the section reads as a footer band
             (david's #B.161: "setting devrait aller en footer"). On
             desktop the natural flow keeps it under projects. -->
        <div class="sidebar-settings">
            <div class="sidebar-section-label">
                Settings
            </div>
            <button
                type="button"
                class="sidebar-item"
                :class="{ active: panel === 'projects' }"
                @click="emit('open-panel', 'projects')"
            >
                <i class="pi pi-folder" />
                <span>Projects</span>
            </button>
            <button
                type="button"
                class="sidebar-item"
                :class="{ active: panel === 'rules' }"
                @click="emit('open-panel', 'rules')"
            >
                <i class="pi pi-cog" />
                <span>Rules</span>
            </button>
            <button
                type="button"
                class="sidebar-item"
                :class="{ active: panel === 'tags' }"
                @click="emit('open-panel', 'tags')"
            >
                <i class="pi pi-tag" />
                <span>Tags</span>
            </button>
            <button
                type="button"
                class="sidebar-item"
                :class="{ active: panel === 'consumers' }"
                @click="emit('open-panel', 'consumers')"
            >
                <i class="pi pi-users" />
                <span>Consumers</span>
            </button>
        </div>
    </aside>
</template>

<style>
.aiball-sidebar {
    border-right: 1px solid var(--p-content-border-color);
    padding: 0.8rem 0.6rem;
    background: var(--p-surface-50);
    overflow-y: auto;
    /* #B.134: fill the grid cell vertically so its internal overflow
       (this rule was already here, kept for explicitness) becomes the
       only scroll context — the parent .aiball-layout now owns
       overflow:hidden, so without height:100% the sidebar would just
       shrink-wrap its content and the page wouldn't scroll at all. */
    height: 100%;
    /* #B.161: flex column so the .sidebar-settings band can push to
       the bottom via margin-top: auto on mobile. */
    display: flex;
    flex-direction: column;
}
.sidebar-projects {
    /* #B.161: <details> default styling — chevron tighter. */
    margin-bottom: 1rem;
}
.sidebar-projects > summary {
    cursor: pointer;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 0.4rem;
}
.sidebar-projects__label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.sidebar-projects > summary::-webkit-details-marker {
    display: none;
}
.sidebar-projects > summary::before {
    content: "▾";
    color: var(--p-text-muted-color);
    font-size: 0.6rem;
}
.sidebar-projects:not([open]) > summary::before {
    content: "▸";
}
.sidebar-new-ticket,
.sidebar-project-settings {
    background: transparent;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.3rem;
    width: 1.6rem;
    height: 1.6rem;
    align-items: center;
    justify-content: center;
    color: var(--p-text-color);
    cursor: pointer;
    font-size: 0.75rem;
}
.sidebar-new-ticket:hover,
.sidebar-project-settings:hover {
    background: var(--p-surface-100);
}
.aiball-dark .sidebar-new-ticket:hover,
.aiball-dark .sidebar-project-settings:hover {
    background: var(--p-surface-800);
}
/* The cog is shown on every viewport — quick access to current
   project's settings (#B.169). The [+] new-ticket is mobile-only
   (desktop has it in the InboxToolbar already). */
.sidebar-project-settings {
    display: inline-flex;
}
.sidebar-new-ticket {
    display: none;
}
@media (max-width: 720px) {
    .sidebar-new-ticket {
        display: inline-flex;
    }
}
.sidebar-settings {
    display: flex;
    flex-direction: column;
}
@media (max-width: 720px) {
    /* #B.161 mobile: settings hidden in the sidebar — App.vue
       renders a duplicate <SidebarFooter> after the inbox so the
       settings scroll naturally below the ticket list (david: "pas
       bloqué sur l'écran, vraiment en scroll apres la liste
       ticket"). Same look as desktop (vertical text list), just
       repositioned.
       Plus collapse the empty bottom space: shrink the sidebar to
       its content height instead of forcing 30vh. */
    .aiball-sidebar {
        max-height: none;
        height: auto;
    }
    .sidebar-settings {
        display: none;
    }
}
.aiball-dark .aiball-sidebar {
    background: var(--p-surface-900);
}
.sidebar-section-label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--p-text-muted-color);
    padding: 0.3rem 0.5rem 0.2rem;
}
.sidebar-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    padding: 0.45rem 0.6rem;
    border-radius: 0.4rem;
    color: var(--p-text-color);
    cursor: pointer;
    font: inherit;
}
.sidebar-item:hover {
    background: var(--p-surface-100);
}
.aiball-dark .sidebar-item:hover {
    background: var(--p-surface-800);
}
.sidebar-item.active {
    background: var(--p-primary-color);
    color: var(--p-primary-contrast-color);
}
.sidebar-item.active:hover {
    background: var(--p-primary-color);
}
.sidebar-item-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.sidebar-badge {
    font-size: 0.72rem;
    font-weight: 600;
    border-radius: 999px;
    padding: 0.05rem 0.4rem;
    line-height: 1.2;
}
.sidebar-badge--pending {
    background: var(--p-yellow-500);
    color: black;
}
.sidebar-badge--unread {
    background: var(--p-blue-500);
    color: white;
}
.sidebar-item.active .sidebar-badge--unread {
    background: white;
    color: var(--p-blue-500);
}
.sidebar-badge--resolved {
    background: var(--p-green-500);
    color: white;
}
.sidebar-item.active .sidebar-badge--resolved {
    background: white;
    color: var(--p-green-500);
}
.sidebar-badge--open {
    background: var(--p-surface-300);
    color: var(--p-text-color);
}
.aiball-dark .sidebar-badge--open {
    background: var(--p-surface-600);
}
</style>
