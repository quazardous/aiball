<script setup lang="ts">
import { onMounted, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { useToast } from "primevue/usetoast";
import { api, type ProjectMeta } from "../lib/api";
import { bus, useBus } from "../lib/bus";
import { estTokenEffort, formatTokens, tokenBreakdownTitle } from "../lib/format";
import DataList from "./ui/DataList.vue";
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
// Self-refresh on bus events — keeps the table in sync without the
// parent having to poke us through a ref.
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
                registry entry. Sorted by latest activity. Deleting a project
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
            :loading="loading && !rows.length"
            :is-empty="!rows.length"
        >
            <template #empty>
                <div class="aiball-empty">
                    <i class="pi pi-folder" style="font-size: 1.6rem" />
                    <div>No projects yet — use "Create project" above or file a ticket.</div>
                </div>
            </template>
            <template #head>
                <th>Project</th>
                <th>Last activity</th>
                <th>Tickets</th>
                <th>Comments</th>
                <th>Tokens</th>
                <th>Pending</th>
                <th />
            </template>
            <template #body>
                <tr
                    v-for="p in rows"
                    :key="p.name"
                    class="projects-row"
                    :title="`Open ${p.name} overview`"
                    @click="emit('open-overview', p.name)"
                >
                    <td data-label="Project">
                        <i class="pi pi-folder" style="margin-right: 0.4rem" />
                        <strong>{{ p.name }}</strong>
                    </td>
                    <td data-label="Last activity" :title="p.last_activity">{{ relativeTime(p.last_activity) }}</td>
                    <td data-label="Tickets">{{ p.ticket_count }}</td>
                    <td data-label="Comments">{{ p.comment_count }}</td>
                    <td
                        data-label="Tokens"
                        :title="p.token_usage ? tokenBreakdownTitle(p.token_usage) : 'no token usage captured yet'"
                    >
                        <span v-if="p.token_usage">⚡ {{ formatTokens(estTokenEffort(p.token_usage)) }}</span>
                        <span v-else style="color: var(--p-text-muted-color)">—</span>
                    </td>
                    <td data-label="Pending">
                        <span v-if="p.pending_count > 0" class="pending-pill">
                            {{ p.pending_count }}
                        </span>
                        <span v-else style="color: var(--p-text-muted-color)">—</span>
                    </td>
                    <!-- #471 david : la cellule action (5 icônes) devient un
                         indicator-cell — point vert si un claude-loop tourne
                         pour ce projet, sinon rien. Read-only. Toute la row
                         clique vers l'overview ; Delete + Purge + Settings +
                         Stats vivent dans les tabs de l'overview. -->
                    <td data-label="" class="indicator-cell">
                        <span
                            v-if="p.running"
                            class="indicator-cell__dot"
                            :title="`A claude-loop is running for ${p.name} — open overview for details`"
                        />
                    </td>
                </tr>
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
/* Look de base (width/border/padding/th) → `.aiball-table` (style.css).
   Ici on ne garde que les deltas : colonnes numériques, action-cell, responsive. */
.projects-table td:nth-child(3),
.projects-table td:nth-child(4),
.projects-table td:nth-child(5),
.projects-table td:nth-child(6),
.projects-table th:nth-child(3),
.projects-table th:nth-child(4),
.projects-table th:nth-child(5),
.projects-table th:nth-child(6) {
    text-align: right;
    width: 6rem;
}
/* #471 david : la row entière clique → overview. cursor + hover affordance.
   Pas de visite des cellules (toute la row est un trigger). */
.projects-table tr.projects-row {
    cursor: pointer;
    transition: background 0.1s;
}
.projects-table tr.projects-row:hover {
    background: var(--p-surface-50);
}
/* #471 david : la cellule actions (5 icônes) devient un indicator-cell. Point
   vert quand un loop tourne pour ce projet, sinon vide. Read-only. */
.projects-table .indicator-cell {
    display: table-cell;
    text-align: right;
    width: 2rem;
    min-width: 0;
    padding-right: 0.75rem;
    vertical-align: middle;
}
.projects-table .indicator-cell__dot {
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--p-green-500);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--p-green-500) 25%, transparent);
}
.pending-pill {
    background: var(--p-yellow-500);
    color: black;
    border-radius: 999px;
    padding: 0.1rem 0.45rem;
    font-size: 0.78rem;
    font-weight: 600;
}

/* #B.254 — narrow viewports : 2-line cards, no attribute labels
   (david #5c8hp5 : "Les cartes sont grosses et vides, utilises des
   cartes sur 2 lignes pas plus. Laisse tomber les noms des attributs
   évident"). Layout :
     Line 1 : [📁 name]  · [time]  · [tickets] [comments] [pending pill]
     Line 2 : [⚙] [📊] [🗑️ purge] [🗑️ delete]                       */
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
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.25rem 0.7rem;
        border: 1px solid var(--p-content-border-color);
        border-radius: 0.5rem;
        padding: 0.45rem 0.65rem;
        margin-bottom: 0.5rem;
        background: var(--p-surface-50);
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
    .projects-table td::before {
        display: none !important;
    }
    /* Line 1 cells — name first, time + counts after. */
    .projects-table td[data-label="Project"] {
        font-size: 0.95rem;
        flex: 1 1 auto;
        min-width: 0;
    }
    .projects-table td[data-label="Last activity"],
    .projects-table td[data-label="Tickets"],
    .projects-table td[data-label="Comments"],
    .projects-table td[data-label="Tokens"] {
        color: var(--p-text-muted-color);
        font-size: 0.78rem;
    }
    /* Drop the en-dash placeholder when there's nothing pending —
       on the compact card it just becomes noise next to the counts. */
    .projects-table td[data-label="Pending"] {
        font-size: 0.78rem;
    }
    /* Indicator dot dans la ligne carte mobile — point vert si running. */
    .projects-table td.indicator-cell {
        flex: 0 0 auto;
        margin-left: auto;
        min-width: 0;
        padding-right: 0;
    }
}
</style>
