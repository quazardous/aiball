<script setup lang="ts">
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
 * Per-project sub-pages — currently just "stats". The entry point lives
 * in Settings > Projects (ProjectsPanel rows), not in the sidebar; we
 * still receive `projectPage` so the inbox item doesn't light up while
 * a sub-page is active.
 */
export type ProjectPage = "stats";

defineProps<{
    items: ProjectListItem[];
    panel: SettingsPanel | null;
    project: string | null;
    projectPage: ProjectPage | null;
}>();

const emit = defineEmits<{
    (e: "select", value: string | null): void;
    (e: "open-panel", panel: SettingsPanel): void;
}>();
</script>

<template>
    <aside class="aiball-sidebar">
        <div class="sidebar-section-label">Projects</div>
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

        <div class="sidebar-section-label" style="margin-top: 1rem">
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
    </aside>
</template>

<style>
.aiball-sidebar {
    border-right: 1px solid var(--p-content-border-color);
    padding: 0.8rem 0.6rem;
    background: var(--p-surface-50);
    overflow-y: auto;
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
