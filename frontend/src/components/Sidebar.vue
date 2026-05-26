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
    /** #393: a claude-loop with a known root runs in this project (local). */
    local?: boolean;
    /** #393 (3c): a claude-loop is currently running (rooted consumer fresh). */
    running?: boolean;
}

export type SettingsPanel = "general" | "automation" | "rules" | "work-filters" | "tags" | "projects" | "consumers" | "nodes" | "launchers" | "compose";

/**
 * Per-project sub-pages (#B.127): "settings" hosts the moderation
 * strategy + future admin; "stats" is read-only metrics. Entry points
 * live in Settings > Projects (ProjectsPanel rows) — sidebar receives
 * `projectPage` so the inbox item doesn't light up while a sub-page
 * is active.
 */
export type ProjectPage = "stats" | "settings" | "detail" | "overview";

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

// #B.161 desktop: clicking the project summary on desktop should NOT
// toggle the details (the projects list is always visible there;
// collapse only makes sense on mobile where vertical space is
// scarce). preventDefault stops the native <details> toggle.
function onProjectsSummaryClick(e: Event) {
    if (window.innerWidth > 720) e.preventDefault();
}

// #341: aiball version, injected at build time from the repo-root
// package.json (see vite.config.ts `define`). Falls back gracefully if
// the define is somehow absent (dev server without the constant).
const appVersion = typeof __AIBALL_VERSION__ === "string" ? __AIBALL_VERSION__ : "dev";
</script>

<template>
    <aside class="aiball-sidebar">
        <!-- #B.161: projects list wrapped in <details> so it collapses
             on mobile via CSS (open by default on desktop, collapsed
             by default on phone — saves the 30vh sidebar band for the
             active project's row only). -->
        <details class="sidebar-projects" :open="projectsOpen">
            <summary
                class="sidebar-section-label"
                @click="onProjectsSummaryClick"
            >
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
<!-- #393 (3c): indicator only — no link here (david jkzk4g: the
                     detail link lives in the Projects page, not the chooser). -->
                <span
                    v-if="p.local && p.value"
                    :class="['sidebar-badge', p.running ? 'sidebar-badge--running' : 'sidebar-badge--local']"
                    :title="p.running
                        ? 'a claude-loop is running here'
                        : 'local — root known, no loop running'"
                ><i class="pi pi-desktop" /></span>
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
                :class="{ active: panel === 'general' }"
                @click="emit('open-panel', 'general')"
            >
                <i class="pi pi-sliders-h" />
                <span>General</span>
            </button>
            <button
                type="button"
                class="sidebar-item"
                :class="{ active: panel === 'projects' }"
                @click="emit('open-panel', 'projects')"
            >
                <i class="pi pi-folder" />
                <span>Projects</span>
            </button>
            <!-- #457: moderation rules + work filters merged under one
                 "Automation" entry (they're both ordered conditional config). -->
            <button
                type="button"
                class="sidebar-item"
                :class="{ active: panel === 'automation' || panel === 'rules' || panel === 'work-filters' }"
                @click="emit('open-panel', 'automation')"
            >
                <i class="pi pi-bolt" />
                <span>Automation</span>
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
            <button
                type="button"
                class="sidebar-item"
                :class="{ active: panel === 'nodes' }"
                @click="emit('open-panel', 'nodes')"
            >
                <i class="pi pi-sitemap" />
                <span>Nodes</span>
            </button>
            <button
                type="button"
                class="sidebar-item"
                :class="{ active: panel === 'launchers' }"
                @click="emit('open-panel', 'launchers')"
            >
                <i class="pi pi-play" />
                <span>Launchers</span>
            </button>
        </div>

        <!-- Version footer (#341). Source: repo-root package.json, injected
             at build time via vite `define` (__AIBALL_VERSION__). -->
        <div class="sidebar-version" :title="`aiball ${appVersion}`">
            aiball v{{ appVersion }}
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
.sidebar-version {
    /* #341: small, muted build version pinned under the settings band. */
    margin-top: 0.6rem;
    padding: 0.35rem 0.4rem 0;
    border-top: 1px solid var(--p-content-border-color);
    font-size: 0.72rem;
    color: var(--p-text-muted-color);
    letter-spacing: 0.02em;
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
@media (min-width: 721px) {
    /* Desktop: project list is always open and click-locked
       (onProjectsSummaryClick preventDefault). The chevron would
       suggest collapsibility that doesn't apply here — drop it. */
    .sidebar-projects > summary {
        cursor: default;
    }
    .sidebar-projects > summary::before {
        display: none;
    }
}
.sidebar-new-ticket,
.sidebar-project-settings {
    background: transparent;
    /* #B.161 follow-up: no border around the cog/+ buttons next to
       the project name (david: "liseret autor du cog à coté nom
       projet pas utile") — hover background is enough affordance. */
    border: 0;
    border-radius: 0.3rem;
    width: 1.6rem;
    height: 1.6rem;
    align-items: center;
    justify-content: center;
    color: var(--p-text-muted-color);
    cursor: pointer;
    font-size: 0.85rem;
}
/* The + new-ticket button is a primary action — green tint, more
   prominent than the settings cog (david: "le bouton compact new
   ticket devrait etre vert"). */
.sidebar-new-ticket {
    color: var(--p-green-600);
}
.sidebar-new-ticket:hover {
    background: color-mix(in srgb, var(--p-green-500) 15%, transparent);
}
.sidebar-project-settings:hover {
    background: var(--p-surface-100);
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
/* #393: "local" — root known but no loop running. Dim desktop chip
   (indicator only — not clickable, see jkzk4g). */
.sidebar-badge--local {
    background: var(--p-surface-400);
    color: var(--p-surface-50);
    padding: 0.05rem 0.35rem;
    opacity: 0.75;
}
/* #393 (3c): "running" — a claude-loop is live here. Green, gently pulsing. */
.sidebar-badge--running {
    background: var(--p-green-500, #22c55e);
    color: #fff;
    padding: 0.05rem 0.35rem;
    animation: sidebar-running-pulse 2s ease-in-out infinite;
}
@keyframes sidebar-running-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
}
.sidebar-badge--local .pi,
.sidebar-badge--running .pi {
    font-size: 0.65rem;
}
</style>
