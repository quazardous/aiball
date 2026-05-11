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

export type SettingsPanel = "rules" | "tags" | "projects" | "compose";

defineProps<{
    items: ProjectListItem[];
    panel: SettingsPanel | null;
    project: string | null;
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
            :class="{ active: panel === null && project === p.value }"
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
    </aside>
</template>
