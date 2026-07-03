<script setup lang="ts">
/**
 * MobileProjectPicker — the toolbar's mobile project dropdown (UI-audit
 * C5.2, extracted from InboxToolbar : ~90 template lines + 19 dedicated
 * CSS rules + the active/inactive split were fully self-contained).
 * The sidebar is display:none under 720px, so this dropdown IS the
 * project picker on mobile (#537 david `f5cjs3`).
 */
import { computed, ref } from "vue";
import { isProjectActive } from "../lib/project-activity";

export interface ProjectOption {
    label: string;
    value: string | null;
    /** Optional counts so the dropdown surfaces the same badges
        as the sidebar did (#B.161 follow-up). */
    pending?: number;
    unread?: number;
    open?: number;
    resolved?: number;
    /** #537 — mirror Sidebar.vue: drives the active/inactive split here too
     *  (sidebar is hidden on mobile, so the toolbar dropdown IS the picker
     *  there — david `f5cjs3` flagged the split was missing). */
    running?: boolean;
    last_activity?: string | null;
}

const props = defineProps<{
    projectOptions: ProjectOption[];
    project: string | null;
}>();
const emit = defineEmits<{
    (e: "update:project", v: string | null): void;
}>();

// #B.161 follow-up: project picker dropdown open state + helpers
// to render the current project's badges inline in the summary.
const projectOpen = ref(false);
const activeProjectLabel = computed(
    () => props.projectOptions.find((p) => p.value === props.project)?.label ?? "All projects",
);
const activeProjectBadges = computed(() => {
    const p = props.projectOptions.find((o) => o.value === props.project);
    if (!p) return [];
    const out: { kind: string; count: number }[] = [];
    if (p.pending && p.pending > 0) out.push({ kind: "pending", count: p.pending });
    if (p.resolved && p.resolved > 0) out.push({ kind: "resolved", count: p.resolved });
    if (p.unread && p.unread > 0) out.push({ kind: "unread", count: p.unread });
    if (p.open && p.open > 0) out.push({ kind: "open", count: p.open });
    return out;
});
function pickProject(v: string | null) {
    emit("update:project", v);
    projectOpen.value = false;
    inactiveOpen.value = false;
}

// #537 mirror Sidebar.vue split (david `f5cjs3` : ça marche pas sur mobile,
// parce que le sidebar est `display:none` sous 720px et ce dropdown est le
// picker mobile — il faut appliquer la même séparation actifs/inactifs ici).
// C5.2 — the active/inactive rule lives in lib/project-activity.ts now.
const allProjectOption = computed(() => props.projectOptions.find((p) => p.value === null) ?? null);
const activeProjectOptions = computed(() =>
    props.projectOptions.filter((p) => p.value !== null && (isProjectActive(p) || p.value === props.project)),
);
const inactiveProjectOptions = computed(() =>
    props.projectOptions.filter((p) => p.value !== null && !isProjectActive(p) && p.value !== props.project),
);
const inactiveOpen = ref(false);
</script>

<template>
    <details
        class="filter-project-dropdown filter-mobile-only"
        :open="projectOpen"
        @toggle="(e: Event) => projectOpen = (e.target as HTMLDetailsElement).open"
    >
        <summary class="filter-project-dropdown__summary" :title="`Current project: ${activeProjectLabel}`">
            <span class="filter-project-dropdown__label">{{ activeProjectLabel }}</span>
            <span v-if="activeProjectBadges.length" class="filter-project-dropdown__badges">
                <span
                    v-for="b in activeProjectBadges"
                    :key="b.kind"
                    class="filter-project-dropdown__badge"
                    :class="`filter-project-dropdown__badge--${b.kind}`"
                >{{ b.count }}</span>
            </span>
            <i class="pi pi-chevron-down filter-project-dropdown__chev" />
        </summary>
        <div class="filter-project-dropdown__menu">
            <!-- #537 — All projects row : toujours en tête. -->
            <button
                v-if="allProjectOption"
                :key="'__all__'"
                type="button"
                class="filter-project-dropdown__item"
                :class="{ 'filter-project-dropdown__item--current': project === null }"
                @click="pickProject(null)"
            >
                <span class="filter-project-dropdown__item-label">{{ allProjectOption.label }}</span>
                <span class="filter-project-dropdown__badges">
                    <span v-if="allProjectOption.pending && allProjectOption.pending > 0" class="filter-project-dropdown__badge filter-project-dropdown__badge--pending">{{ allProjectOption.pending }}</span>
                    <span v-if="allProjectOption.resolved && allProjectOption.resolved > 0" class="filter-project-dropdown__badge filter-project-dropdown__badge--resolved">{{ allProjectOption.resolved }}</span>
                    <span v-if="allProjectOption.unread && allProjectOption.unread > 0" class="filter-project-dropdown__badge filter-project-dropdown__badge--unread">{{ allProjectOption.unread }}</span>
                    <span v-if="allProjectOption.open && allProjectOption.open > 0" class="filter-project-dropdown__badge filter-project-dropdown__badge--open">{{ allProjectOption.open }}</span>
                </span>
            </button>
            <!-- Active projects (running OU signal counter récent). -->
            <button
                v-for="p in activeProjectOptions"
                :key="p.value ?? '__active__'"
                type="button"
                class="filter-project-dropdown__item"
                :class="{ 'filter-project-dropdown__item--current': p.value === project }"
                @click="pickProject(p.value)"
            >
                <span class="filter-project-dropdown__item-label">{{ p.label }}</span>
                <span class="filter-project-dropdown__badges">
                    <span v-if="p.pending && p.pending > 0" class="filter-project-dropdown__badge filter-project-dropdown__badge--pending">{{ p.pending }}</span>
                    <span v-if="p.resolved && p.resolved > 0" class="filter-project-dropdown__badge filter-project-dropdown__badge--resolved">{{ p.resolved }}</span>
                    <span v-if="p.unread && p.unread > 0" class="filter-project-dropdown__badge filter-project-dropdown__badge--unread">{{ p.unread }}</span>
                    <span v-if="p.open && p.open > 0" class="filter-project-dropdown__badge filter-project-dropdown__badge--open">{{ p.open }}</span>
                </span>
            </button>
            <!-- More toggle pour révéler les projets inactifs. -->
            <button
                v-if="inactiveProjectOptions.length > 0"
                type="button"
                class="filter-project-dropdown__item filter-project-dropdown__item--more"
                @click="inactiveOpen = !inactiveOpen"
            >
                <i :class="`pi ${inactiveOpen ? 'pi-chevron-up' : 'pi-chevron-down'}`" style="font-size: var(--fs-2xs); opacity: 0.6" />
                <span class="filter-project-dropdown__item-label filter-project-dropdown__item-label--muted">{{ inactiveOpen ? 'Less' : `More (${inactiveProjectOptions.length})` }}</span>
            </button>
            <!-- Inactive projects (juste open/snoozed, OU activity > 14j). -->
            <button
                v-for="p in (inactiveOpen ? inactiveProjectOptions : [])"
                :key="`inactive-${p.value}`"
                type="button"
                class="filter-project-dropdown__item filter-project-dropdown__item--inactive"
                :class="{ 'filter-project-dropdown__item--current': p.value === project }"
                @click="pickProject(p.value)"
            >
                <span class="filter-project-dropdown__item-label">{{ p.label }}</span>
                <span class="filter-project-dropdown__badges">
                    <span v-if="p.open && p.open > 0" class="filter-project-dropdown__badge filter-project-dropdown__badge--open">{{ p.open }}</span>
                </span>
            </button>
        </div>
    </details>
</template>

<style>
/* Non-scoped like the parent toolbar (dark-theme reach) ; the
   .filter-project-dropdown namespace moved here with its markup. */
.filter-project-dropdown {
    position: relative;
    flex: 0 1 auto;
}
.filter-project-dropdown > summary {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
    list-style: none;
    padding: 0.3rem 0.55rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: var(--radius-md);
    background: var(--p-surface-0);
    font-size: var(--fs-md);
    max-width: 12rem;
}
.filter-project-dropdown > summary::-webkit-details-marker { display: none; }
.filter-project-dropdown__label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.filter-project-dropdown__chev {
    font-size: 0.65rem;
    color: var(--p-text-muted-color);
    transition: transform 0.15s;
}
.filter-project-dropdown[open] .filter-project-dropdown__chev {
    transform: rotate(180deg);
}
.filter-project-dropdown__menu {
    position: absolute;
    top: calc(100% + 0.25rem);
    left: 0;
    min-width: 16rem;
    max-width: calc(100vw - 2rem);
    background: var(--p-content-background);
    border: 1px solid var(--p-content-border-color);
    border-radius: var(--radius-md);
    box-shadow: 0 6px 16px rgba(0,0,0,0.12);
    z-index: 20;
    padding: 0.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    max-height: 70vh;
    overflow-y: auto;
}
.filter-project-dropdown__item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.6rem;
    background: transparent;
    border: 0;
    border-radius: var(--radius-sm);
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-lg);
    color: var(--p-text-color);
}
.filter-project-dropdown__item:hover {
    background: var(--p-surface-100);
}
.filter-project-dropdown__item--current {
    color: var(--p-primary-color);
    font-weight: 600;
}
.filter-project-dropdown__item-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.filter-project-dropdown__badges {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
}
.filter-project-dropdown__badge {
    font-size: var(--fs-2xs);
    font-weight: 600;
    border-radius: var(--radius-pill);
    padding: 0.1rem 0.4rem;
    line-height: 1;
}
.filter-project-dropdown__badge--pending { background: var(--p-yellow-500); color: black; }
.filter-project-dropdown__badge--unread  { background: var(--p-blue-500); color: white; }
.filter-project-dropdown__badge--resolved{ background: var(--p-green-500); color: white; }
.filter-project-dropdown__badge--open    { background: var(--p-surface-200); color: var(--p-text-color); }
.filter-project-dropdown__item--more {
    gap: 0.4rem;
    color: var(--p-text-muted-color);
    font-size: var(--fs-sm);
    padding-block: 0.3rem;
}
.filter-project-dropdown__item-label--muted {
    color: var(--p-text-muted-color);
}
.filter-project-dropdown__item--inactive .filter-project-dropdown__item-label {
    color: var(--p-text-muted-color);
}
</style>
