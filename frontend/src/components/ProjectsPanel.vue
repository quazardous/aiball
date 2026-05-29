<script setup lang="ts">
import { onMounted, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { useToast } from "primevue/usetoast";
import { api, type ProjectMeta } from "../lib/api";
import { bus, useBus } from "../lib/bus";
import { estTokenEffort, formatTokens, tokenBreakdownTitle } from "../lib/format";
import DataList, { type DataListColumn } from "./ui/DataList.vue";
import PanelHeader from "./ui/PanelHeader.vue";

const toast = useToast();
const rows = ref<ProjectMeta[]>([]);
const loading = ref(false);
const creating = ref(false);
const newName = ref("");
const creatingForm = ref(false);

// #471 david : la liste ne pilote plus directement les actions (Delete /
// Purge / Settings / Stats / Detail). Tout passe par une page overview
// unifiée — un seul emit, une seule cible. La row entière devient
// cliquable, les indicateurs (loop running) restent visibles mais
// non-cliquables individuellement.
const emit = defineEmits<{
    (e: "open-overview", project: string): void;
}>();

// #592 — declarative columns ; sort + headers handled by DataList.
const columns: DataListColumn[] = [
    { key: "name", label: "Project", sortable: true, defaultDir: "asc" },
    { key: "last_activity", label: "Last activity", sortable: true, defaultDir: "desc", cellClass: "col-num" },
    { key: "ticket_count", label: "Tickets", sortable: true, defaultDir: "desc", cellClass: "col-num" },
    { key: "comment_count", label: "Comments", sortable: true, defaultDir: "desc", cellClass: "col-num" },
    { key: "token_usage", label: "Tokens", sortable: true, defaultDir: "desc", cellClass: "col-num" },
    { key: "pending_count", label: "Pending", sortable: true, defaultDir: "desc", cellClass: "col-num" },
    { key: "_indicator", label: "", cellClass: "indicator-cell" },
];

function sortValue(row: ProjectMeta, key: string): string | number {
    switch (key) {
        case "name": return row.name.toLowerCase();
        case "last_activity": return new Date(row.last_activity).getTime();
        case "ticket_count": return row.ticket_count;
        case "comment_count": return row.comment_count;
        case "token_usage": return row.token_usage ? estTokenEffort(row.token_usage) : -1;
        case "pending_count": return row.pending_count;
        default: return "";
    }
}

async function load() {
    loading.value = true;
    try {
        rows.value = await api.listProjectsDetailed();
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Failed to load projects",
            detail: (e as Error).message,
            life: 8000,
        });
    } finally {
        loading.value = false;
    }
}

async function submitCreate() {
    const name = newName.value.trim();
    if (!name) return;
    creating.value = true;
    try {
        const row = await api.createProject(name);
        toast.add({
            severity: "success",
            summary: `Project "${row.name}" registered`,
            life: 4000,
        });
        newName.value = "";
        creatingForm.value = false;
        bus.emit("projects.refresh");
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Create failed",
            detail: (e as Error).message,
            life: 8000,
        });
    } finally {
        creating.value = false;
    }
}

function relativeTime(iso: string): string {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = 60_000, hr = 3_600_000, day = 86_400_000;
    if (diff < hr) return `${Math.max(1, Math.floor(diff / min))}m ago`;
    if (diff < day) return `${Math.floor(diff / hr)}h ago`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
    return d.toLocaleDateString();
}

onMounted(load);
useBus("projects.refresh", () => load());
defineExpose({ load });
</script>

<template>
    <div class="projects-panel">
        <PanelHeader title="Projects">
            <template #actions>
                <Button
                    v-if="!creatingForm"
                    label="Create project"
                    icon="pi pi-plus"
                    size="small"
                    @click="creatingForm = true"
                />
            </template>
            <p class="aiball-explainer aiball-explainer--muted">
                One row per project that has at least one message OR an explicit
                registry entry. Click a column header to sort. Deleting a project
                hard-removes every message, comment, close event, and project
                subscription it owns. Ticket-level pings cascade away with the
                messages. The action is irreversible.
            </p>
            <form v-if="creatingForm" class="create-project-form" @submit.prevent="submitCreate">
                <InputText
                    v-model="newName"
                    placeholder="project-name"
                    autofocus
                    :disabled="creating"
                />
                <Button
                    type="submit"
                    label="Create"
                    icon="pi pi-check"
                    size="small"
                    :loading="creating"
                    :disabled="!newName.trim()"
                />
                <Button
                    type="button"
                    label="Cancel"
                    size="small"
                    severity="secondary"
                    text
                    :disabled="creating"
                    @click="creatingForm = false; newName = ''"
                />
            </form>
        </PanelHeader>

        <DataList
            table-class="projects-table"
            :columns="columns"
            :rows="rows"
            :row-key="(r: ProjectMeta) => r.name"
            :row-title="(r: ProjectMeta) => `Open ${r.name} overview`"
            :row-class="() => 'dl-clickable'"
            :get-sort-value="sortValue"
            default-sort-key="last_activity"
            default-sort-dir="desc"
            :loading="loading && !rows.length"
            :is-empty="!rows.length"
            @row-click="(r: ProjectMeta) => emit('open-overview', r.name)"
        >
            <template #empty>
                <div class="aiball-empty">
                    <i class="pi pi-folder" style="font-size: 1.6rem" />
                    <div>No projects yet — use "Create project" above or file a ticket.</div>
                </div>
            </template>
            <template #cell-name="{ row }">
                <strong>{{ (row as ProjectMeta).name }}</strong>
            </template>
            <template #cell-last_activity="{ row }">
                <span :title="(row as ProjectMeta).last_activity">{{ relativeTime((row as ProjectMeta).last_activity) }}</span>
            </template>
            <template #cell-ticket_count="{ row }">{{ (row as ProjectMeta).ticket_count }}</template>
            <template #cell-comment_count="{ row }">{{ (row as ProjectMeta).comment_count }}</template>
            <template #cell-token_usage="{ row }">
                <span
                    :title="(row as ProjectMeta).token_usage ? tokenBreakdownTitle((row as ProjectMeta).token_usage!) : 'no token usage captured yet'"
                >
                    <span v-if="(row as ProjectMeta).token_usage">⚡ {{ formatTokens(estTokenEffort((row as ProjectMeta).token_usage!)) }}</span>
                    <span v-else style="color: var(--p-text-muted-color)">—</span>
                </span>
            </template>
            <template #cell-pending_count="{ row }">
                <span v-if="(row as ProjectMeta).pending_count > 0" class="pending-pill">
                    {{ (row as ProjectMeta).pending_count }}
                </span>
                <span v-else style="color: var(--p-text-muted-color)">—</span>
            </template>
            <template #cell-_indicator="{ row }">
                <span
                    v-if="(row as ProjectMeta).running"
                    class="indicator-cell__dot"
                    :title="`A claude-loop is running for ${(row as ProjectMeta).name} — open overview for details`"
                />
            </template>
        </DataList>
    </div>
</template>

<style>
.projects-panel {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
}
.create-project-form {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
}
/* `.col-num` / `.indicator-cell` / `.dl-clickable` row hover all live in
   `ui/DataList.vue`'s shared styles — improving them there propagates here.
   Only the project-specific pending pill stays. */
.pending-pill {
    background: var(--p-yellow-500);
    color: black;
    border-radius: 999px;
    padding: 0.1rem 0.45rem;
    font-size: 0.78rem;
    font-weight: 600;
}

/* #B.254 / #610 — narrow viewports : 2-line cards. #610 david — re-add
   the per-cell label (data-label injecté par DataList) en préfixe muted
   pour que l'utilisateur reconnaisse les colonnes (avant, thead caché
   ET pas de label → cards anonymes). */
@media (max-width: 720px) {
    .projects-panel {
        gap: 0.6rem;
    }
    .aiball-explainer {
        font-size: 0.82rem;
    }
    .create-project-form {
        flex-wrap: wrap;
    }
    .create-project-form :deep(.p-inputtext) {
        flex: 1 1 100%;
        min-width: 0;
    }
    .projects-table thead {
        display: none;
    }
    .projects-table,
    .projects-table tbody,
    .projects-table tr {
        display: block;
        width: 100%;
    }
    .projects-table tr {
        /* #610 david — "les cards doivent devenir plus des row" : on
           drop le chrome card (border full + radius + background), on
           garde juste un border-bottom comme séparateur de row. Padding
           interne conservé pour que le texte ne touche pas le bord. */
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.25rem 0.7rem;
        border: none;
        border-bottom: 1px solid var(--p-content-border-color);
        border-radius: 0;
        padding: 0.5rem 0.7rem;
        margin-bottom: 0;
        background: transparent;
    }
    .projects-table td {
        flex: 0 0 auto;
        padding: 0;
        border: none;
        text-align: left !important;
        width: auto !important;
        min-height: 0;
        display: inline-flex;
        align-items: baseline;
    }
    /* #610 : préfixe le contenu de chaque cellule par son header (data-label
       injecté par DataList). Skip pour la 1ère cellule (Name) qui se
       présente seule, et pour l'indicator-cell (juste un dot, pas de label).
       attr() avec fallback vide → si data-label est absent, rien ne s'affiche. */
    .projects-table td:not(:first-child):not(.indicator-cell)[data-label]::before {
        content: attr(data-label) ": ";
        color: var(--p-text-muted-color);
        font-size: 0.78rem;
        margin-right: 0.3rem;
    }
    .projects-table td.indicator-cell {
        margin-left: auto;
        padding-right: 0;
    }
}
</style>
