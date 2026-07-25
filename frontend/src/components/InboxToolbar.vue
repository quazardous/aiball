<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from "vue";
import Button from "primevue/button";
import Select from "primevue/select";
import ToggleButton from "primevue/togglebutton";
import InputText from "primevue/inputtext";
import Dialog from "primevue/dialog";
import { useToast } from "primevue/usetoast";
import { type SortBy, type StatusFilter } from "../lib/labels";
import { api, PRIORITIES, type Priority } from "../lib/api";
import { bus } from "../lib/bus";
import { upstreamBindings } from "../lib/upstream-providers";

/** #B.222 priority filter — "all" + each enum value. Owned here so
 *  parents don't have to mirror PRIORITIES at every call-site. */
const priorityFilterOptions: { label: string; value: "all" | Priority }[] = [
    { label: "all priorities", value: "all" },
    ...PRIORITIES.map((p) => ({ label: p, value: p as Priority })),
];

// Toolbar receives the options arrays as props so the parent can swap
// them out if needed; the canonical defaults live in lib/labels.ts.
export interface StatusFilterOption {
    label: string;
    value: StatusFilter;
}

export interface SortOption {
    label: string;
    value: SortBy;
}

import MobileProjectPicker, { type ProjectOption } from "./MobileProjectPicker.vue";
export type { ProjectOption } from "./MobileProjectPicker.vue";
const props = defineProps<{
    statusFilter: StatusFilter;
    statusFilterOptions: StatusFilterOption[];
    onlyOpen: boolean;
    sortBy: SortBy;
    sortOptions: SortOption[];
    searchQuery: string;
    /** Project picker — only used on mobile (sidebar is hidden there). */
    projectOptions: ProjectOption[];
    project: string | null;
    /** #B.222 priority filter — "all" or one of the enum values. */
    priorityFilter: "all" | Priority;
}>();

const emit = defineEmits<{
    (e: "update:statusFilter", v: StatusFilter): void;
    (e: "update:onlyOpen", v: boolean): void;
    (e: "update:sortBy", v: SortBy): void;
    (e: "update:searchQuery", v: string): void;
    (e: "update:project", v: string | null): void;
    (e: "update:priorityFilter", v: "all" | Priority): void;
    (e: "open-current-settings"): void;
    (e: "new-ticket"): void;
}>();

// C5.2 — the mobile project picker (dropdown + active/inactive split) is
// its own component now : MobileProjectPicker.vue.

// #B.161: filters collapse on mobile (<720px). Default-open on
// desktop, default-collapsed on mobile; resize keeps the state in
// sync if the viewport crosses the breakpoint.
const filtersExpanded = ref(typeof window === "undefined" || window.innerWidth > 720);
// #259: the new-ticket button label is full ("New Ticket") on desktop,
// short ("New") on phone where horizontal room is scarce — the pi-plus
// icon already conveys "create". Same 720px breakpoint as the filters
// collapse, kept in sync on resize.
const isPhone = ref(typeof window !== "undefined" && window.innerWidth <= 720);
function syncFilters() {
    filtersExpanded.value = window.innerWidth > 720;
    isPhone.value = window.innerWidth <= 720;
}
onMounted(() => window.addEventListener("resize", syncFilters));
onUnmounted(() => window.removeEventListener("resize", syncFilters));

// #1542 — import an external issue as a coupled ticket. Shown only when the
// current project has a default upstream (github) binding. Self-contained
// dialog: enter a ref (gh#N / gh:owner/repo#N), POST, toast, refresh the inbox.
const toast = useToast();
const canImportUpstream = computed<boolean>(() => {
    if (!props.project) return false;
    const bindings = upstreamBindings.value[props.project];
    return !!bindings && bindings.some((b) => b.kind === "github" && b.default);
});
const importOpen = ref(false);
const importRef = ref("");
const importBusy = ref(false);
function openImport() {
    importRef.value = "";
    importOpen.value = true;
}
async function doImport() {
    const ref_ = importRef.value.trim();
    if (!ref_ || !props.project) return;
    importBusy.value = true;
    try {
        const res = await api.importUpstream(ref_, props.project);
        toast.add({
            severity: "success",
            summary: "Imported from GitHub",
            detail: `Created ticket #${res.ticket.id} from ${res.provider} #${res.external.num}`,
            life: 5000,
        });
        importOpen.value = false;
        bus.emit("inbox.refresh");
        bus.emit("projects.refresh");
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Import failed",
            detail: (e as Error).message,
            life: 6000,
        });
    } finally {
        importBusy.value = false;
    }
}
</script>

<template>
    <div class="filters-bar">
        <!-- #B.161 mobile: project picker = native CSS dropdown
             with badges per project (david: "remet les compteurs"
             + "drop down etc de manière plus css"). Sidebar hidden,
             this carries the navigation + the visual counts. -->
        <MobileProjectPicker
            :project-options="projectOptions"
            :project="project"
            @update:project="(v: string | null) => emit('update:project', v)"
        />
        <button
            v-if="project"
            type="button"
            class="filter-project-settings filter-mobile-only"
            title="Project settings"
            @click="emit('open-current-settings')"
        >
            <i class="pi pi-cog" />
        </button>
        <!-- The less-frequently-used filters (status, only-open,
             sort) collapse inside a <details> panel on mobile.
             Desktop CSS forces the details open so the bar reads
             flat as before. -->
        <!-- #B.161: filters chip (row-1 clickable) + body as
             SEPARATE siblings — the previous <details> +
             display:contents combo had flexbox ordering bugs that
             couldn't keep new-ticket on row 1 when the body
             wrapped. Now everything is a direct flex child of
             filters-bar with explicit `order`. -->
        <button
            type="button"
            class="filters-chip filter-mobile-only"
            :class="{ 'filters-chip--open': filtersExpanded }"
            title="Filters"
            @click="filtersExpanded = !filtersExpanded"
        >
            <i class="pi pi-filter" /> filters
        </button>
        <!-- #259: full "New Ticket" on desktop, short "New" on phone
             (the pi-plus icon already conveys "create" where room is
             scarce). #B.258 shortened it everywhere; now responsive. -->
        <Button
            class="filter-new-ticket"
            :label="isPhone ? 'New' : 'New Ticket'"
            icon="pi pi-plus"
            size="small"
            title="New ticket"
            @click="emit('new-ticket')"
        />
        <!-- #1542 — import a GitHub issue as a coupled ticket. Only when the
             current project has a default upstream binding. -->
        <Button
            v-if="canImportUpstream"
            class="filter-import-upstream"
            :label="isPhone ? '' : 'Import'"
            icon="pi pi-github"
            size="small"
            severity="secondary"
            outlined
            title="Import a GitHub issue as a coupled ticket"
            @click="openImport"
        />
        <div class="filters-body" :class="{ 'filters-body--collapsed': !filtersExpanded }">
                <Select
                    :model-value="statusFilter"
                    :options="statusFilterOptions"
                    option-label="label"
                    option-value="value"
                    size="small"
                    class="filter-select"
                    @update:model-value="(v: StatusFilter) => emit('update:statusFilter', v)"
                />
                <ToggleButton
                    :model-value="onlyOpen"
                    on-label="open only"
                    off-label="all"
                    on-icon="pi pi-folder-open"
                    off-icon="pi pi-folder"
                    size="small"
                    @update:model-value="(v: boolean) => emit('update:onlyOpen', v)"
                />
                <Select
                    :model-value="sortBy"
                    :options="sortOptions"
                    option-label="label"
                    option-value="value"
                    size="small"
                    class="filter-select"
                    title="Sort order"
                    @update:model-value="(v: SortBy) => emit('update:sortBy', v)"
                />
                <!-- #B.222: priority filter — narrows the inbox to a
                     single urgency tier. Wired through to /api/inbox
                     ?priority=… which filters server-side. -->
                <Select
                    :model-value="priorityFilter"
                    :options="priorityFilterOptions"
                    option-label="label"
                    option-value="value"
                    size="small"
                    class="filter-select"
                    title="Filter by priority"
                    @update:model-value="(v: 'all' | Priority) => emit('update:priorityFilter', v)"
                />
                <!-- #B.161 row-saver: search joins the filter body
                     so the mobile layout becomes row 1 = [project,
                     cog, filters, +new], row 2 = [all, open-only,
                     recent, search]. David: "search à droite de
                     recente activity, on gagne une ligne". On
                     desktop the body is display: contents so search
                     stays inline like before. -->
                <span class="filter-search-wrap">
                    <InputText
                        :model-value="searchQuery"
                        placeholder="Search…"
                        size="small"
                        class="filter-search"
                        title="Free-text search across ticket titles, bodies and comments (whitespace = AND)"
                        @update:model-value="(v: string | undefined) => emit('update:searchQuery', v ?? '')"
                    />
                    <button
                        v-if="searchQuery"
                        type="button"
                        class="filter-search__clear"
                        title="Clear search"
                        @click="emit('update:searchQuery', '')"
                    >
                        <i class="pi pi-times" />
                    </button>
                </span>
        </div>
        <span class="spacer" />
    </div>

    <!-- #1542 — import dialog. Enter a ref (gh#123 or gh:owner/repo#123). -->
    <Dialog
        v-model:visible="importOpen"
        modal
        header="Import from GitHub"
        :style="{ width: '28rem', maxWidth: '92vw' }"
    >
        <p class="import-dialog__hint">
            Enter a GitHub issue reference. A bare <code>gh#123</code> uses this
            project's default repo; <code>gh:owner/repo#123</code> targets any repo.
        </p>
        <InputText
            v-model="importRef"
            placeholder="gh#123"
            class="import-dialog__input"
            autofocus
            @keyup.enter="doImport"
        />
        <template #footer>
            <Button label="Cancel" text severity="secondary" @click="importOpen = false" />
            <Button
                label="Import"
                icon="pi pi-github"
                :loading="importBusy"
                :disabled="!importRef.trim()"
                @click="doImport"
            />
        </template>
    </Dialog>
</template>

<style>
.filters-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--p-content-border-color);
    margin-bottom: 0.4rem;
}
/* #B.161: project picker + cog inside the toolbar — visible only
   on mobile (desktop has them in the sidebar). */
.filter-mobile-only {
    display: none;
}
.filter-project {
    flex: 0 1 auto;
    min-width: 7rem;
    max-width: 10rem;
}
/* #537 — toggle « More (N) » pour révéler les projets inactifs, mirror du
   sidebar : chevron + label muted, visuellement discret. */
.filter-project-settings {
    background: transparent;
    border: 0;
    border-radius: var(--radius-sm);
    width: 1.8rem;
    height: 1.8rem;
    align-items: center;
    justify-content: center;
    color: var(--p-text-muted-color);
    cursor: pointer;
}
.filter-project-settings:hover {
    background: var(--p-surface-100);
}
/* #B.161: filters chip = text-link style mobile toggle. Desktop
   hides the chip entirely (filters-body stays inline always). */
.filters-chip {
    display: none;
    align-items: center;
    gap: 0.25rem;
    padding: 0.2rem 0.4rem;
    border: 0;
    background: transparent;
    color: var(--p-text-muted-color);
    font: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
    user-select: none;
}
.filters-chip:hover {
    color: var(--p-text-color);
}
.filters-body {
    /* Desktop: behaves like the old inline flex (display: contents
       lets each child be a direct flex item of filters-bar). */
    display: contents;
}
@media (max-width: 720px) {
    .filter-mobile-only {
        display: inline-flex;
    }
    .filter-project-settings.filter-mobile-only {
        display: inline-flex;
    }
    .filters-collapse__summary {
        display: inline-flex;
    }
    .filters-collapse:not([open]) .filters-collapse__body {
        display: none;
    }
    .filters-collapse {
        display: contents;
    }
    /* Mobile: filters-chip becomes visible, body is hidden when
       collapsed, body takes its own row when expanded (flex-basis
       100% + explicit order:9 ensures it renders AFTER all row-1
       items regardless of source position). */
    .filters-chip {
        display: inline-flex;
    }
    .filters-body {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
        flex: 1 0 100%;
        padding: 0.3rem 0;
        order: 9;
    }
    /* Must come AFTER .filters-body to win the same-specificity
       tie — otherwise display: flex above hides the collapse. */
    .filters-body--collapsed {
        display: none;
    }
    .filter-project-dropdown,
    .filter-project-settings,
    .filters-chip,
    .filter-new-ticket {
        order: 0;
    }
    /* Compact filters-bar layout on mobile: search wide, new ticket
       icon-only (label hidden), spacer collapses. */
    .filter-search {
        min-width: 0;
        width: 100%;
    }
    .filter-search-wrap {
        flex: 1 1 auto;
    }
    /* #288 david "la partie choix projet et filtre est un peu petite —
       plus 20%": scale the row-1 controls (project picker, cog, filters
       chip, New) ~1.2× on phone for legibility + bigger tap targets.
       FONT sizes are the +20%; HORIZONTAL padding/gaps are kept tight so
       the bigger controls still fit New on row 1 (david #9zsw3m: "le new
       est à la ligne — resserre les margin/padding horizontaux autour du
       bouton filter"). */
    .filters-bar {
        gap: 0.35rem;              /* was 0.5 — claw back inter-item space */
    }
    .filter-project-dropdown > summary {
        font-size: 1.02rem;        /* 0.85 × 1.2 */
        padding: 0.36rem 0.5rem;   /* vertical bumped, horizontal kept tight */
        max-width: 14rem;
    }
    .filter-project-dropdown__chev {
        font-size: var(--fs-sm);        /* 0.65 × 1.2 */
    }
    .filter-project-dropdown__badge {
        font-size: 0.84rem;        /* 0.7 × 1.2 */
        padding: 0.12rem 0.34rem;  /* horizontal trimmed (×4 badges adds up) */
    }
    .filter-project-settings {
        width: 2.15rem;            /* 1.8 × 1.2 */
        height: 2.15rem;
    }
    .filter-project-settings .pi {
        font-size: 1.15rem;
    }
    .filters-chip {
        font-size: 0.94rem;        /* 0.78 × 1.2 — size kept */
        padding: 0.24rem 0.15rem;  /* horizontal squeezed hard (david's ask) */
    }
    .filter-new-ticket {
        font-size: 0.95rem;
        padding: 0.42rem 0.6rem;
    }
    .filter-new-ticket .p-button-icon {
        font-size: 1.05rem;
    }
}
.filter-select {
    min-width: 9rem;
}
.filter-search {
    min-width: 12rem;
}
.filter-search-wrap {
    position: relative;
    display: inline-flex;
}
.filter-search-wrap .filter-search :deep(input) {
    padding-right: 1.8rem;
}
.filter-search__clear {
    position: absolute;
    right: 0.35rem;
    top: 50%;
    transform: translateY(-50%);
    background: transparent;
    border: none;
    padding: 0.15rem 0.3rem;
    cursor: pointer;
    color: var(--p-text-muted-color);
    line-height: 1;
    border-radius: 0.2rem;
}
.filter-search__clear:hover {
    color: var(--p-text-color);
    background: var(--p-surface-100);
}
.filter-search__clear i {
    font-size: var(--fs-sm);
}
/* #1542 — import dialog. */
.import-dialog__hint {
    margin: 0 0 0.6rem;
    font-size: var(--fs-sm);
    color: var(--p-text-muted-color);
}
.import-dialog__input {
    width: 100%;
}
</style>
