<script setup lang="ts">
import { onMounted, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { useToast } from "primevue/usetoast";
import { api, type ProjectMeta } from "../lib/api";
import { bus, useBus } from "../lib/bus";

const toast = useToast();
const rows = ref<ProjectMeta[]>([]);
const loading = ref(false);
const confirming = ref<string | null>(null);
const deleting = ref<string | null>(null);
const confirmingPurge = ref<string | null>(null);
const purging = ref<string | null>(null);
const creating = ref(false);
const newName = ref("");
const creatingForm = ref(false);

const emit = defineEmits<{
    (e: "open-stats", project: string): void;
    (e: "open-settings", project: string): void;
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

async function confirmPurge(name: string) {
    purging.value = name;
    try {
        const r = await api.purgeOldClosed(name, 365);
        if (r.purged_tickets === 0) {
            toast.add({
                severity: "info",
                summary: `"${r.project}" — nothing to purge`,
                detail: `No tickets closed more than ${r.older_than_days} days ago.`,
                life: 6000,
            });
        } else {
            toast.add({
                severity: "success",
                summary: `Purged ${r.purged_tickets} ticket(s) from "${r.project}"`,
                detail: `${r.purged_messages} message(s) removed (closed > ${r.older_than_days}d).`,
                life: 8000,
            });
        }
        confirmingPurge.value = null;
        bus.emit("projects.refresh");
        bus.emit("inbox.refresh");
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Purge failed",
            detail: (e as Error).message,
            life: 8000,
        });
    } finally {
        purging.value = null;
    }
}

async function confirmDelete(name: string) {
    deleting.value = name;
    try {
        const r = await api.deleteProject(name);
        toast.add({
            severity: "success",
            summary: `Deleted project "${r.project}"`,
            detail: `${r.deleted_messages} message(s) removed`,
            life: 8000,
        });
        confirming.value = null;
        // WS will also fire project_deleted shortly; emitting locally
        // keeps the panel responsive without waiting for the round-trip.
        bus.emit("project.deleted", { project: r.project });
        bus.emit("projects.refresh");
        bus.emit("inbox.refresh");
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Delete failed",
            detail: (e as Error).message,
            life: 8000,
        });
    } finally {
        deleting.value = null;
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
        <header class="rules-explainer-block">
            <div class="projects-header-row">
                <h2 style="margin: 0">Projects</h2>
                <Button
                    v-if="!creatingForm"
                    label="Create project"
                    icon="pi pi-plus"
                    size="small"
                    @click="creatingForm = true"
                />
            </div>
            <p class="rules-explainer rules-explainer--muted">
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
        </header>

        <div v-if="loading && !rows.length" class="aiball-empty">Loading…</div>
        <div v-else-if="!rows.length" class="aiball-empty">
            <i class="pi pi-folder" style="font-size: 1.6rem" />
            <div>No projects yet — use "Create project" above or file a ticket.</div>
        </div>

        <table v-else class="projects-table">
            <thead>
                <tr>
                    <th>Project</th>
                    <th>Last activity</th>
                    <th>Tickets</th>
                    <th>Comments</th>
                    <th>Pending</th>
                    <th />
                </tr>
            </thead>
            <tbody>
                <tr v-for="p in rows" :key="p.name">
                    <td data-label="Project">
                        <i class="pi pi-folder" style="margin-right: 0.4rem" />
                        <strong>{{ p.name }}</strong>
                    </td>
                    <td data-label="Last activity" :title="p.last_activity">{{ relativeTime(p.last_activity) }}</td>
                    <td data-label="Tickets">{{ p.ticket_count }}</td>
                    <td data-label="Comments">{{ p.comment_count }}</td>
                    <td data-label="Pending">
                        <span v-if="p.pending_count > 0" class="pending-pill">
                            {{ p.pending_count }}
                        </span>
                        <span v-else style="color: var(--p-text-muted-color)">—</span>
                    </td>
                    <td data-label="" class="action-cell">
                        <template v-if="confirming === p.name">
                            <span class="confirm-text">Really delete?</span>
                            <Button
                                label="confirm"
                                icon="pi pi-trash"
                                severity="danger"
                                size="small"
                                :loading="deleting === p.name"
                                @click="confirmDelete(p.name)"
                            />
                            <Button
                                label="cancel"
                                size="small"
                                severity="secondary"
                                text
                                @click="confirming = null"
                            />
                        </template>
                        <template v-else-if="confirmingPurge === p.name">
                            <span class="confirm-text">Purge tickets closed &gt; 1 year?</span>
                            <Button
                                label="confirm"
                                icon="pi pi-eraser"
                                severity="warn"
                                size="small"
                                :loading="purging === p.name"
                                @click="confirmPurge(p.name)"
                            />
                            <Button
                                label="cancel"
                                size="small"
                                severity="secondary"
                                text
                                @click="confirmingPurge = null"
                            />
                        </template>
                        <template v-else>
                            <Button
                                icon="pi pi-cog"
                                severity="secondary"
                                text
                                rounded
                                size="small"
                                title="Project settings — moderation strategy (#B.127)"
                                @click="emit('open-settings', p.name)"
                            />
                            <Button
                                icon="pi pi-chart-bar"
                                severity="secondary"
                                text
                                rounded
                                size="small"
                                title="Open per-project stats"
                                @click="emit('open-stats', p.name)"
                            />
                            <Button
                                icon="pi pi-eraser"
                                severity="warn"
                                text
                                rounded
                                size="small"
                                title="Purge tickets closed more than 1 year ago"
                                @click="confirmingPurge = p.name"
                            />
                            <Button
                                icon="pi pi-trash"
                                severity="danger"
                                text
                                rounded
                                size="small"
                                title="Delete this project"
                                @click="confirming = p.name"
                            />
                        </template>
                    </td>
                </tr>
            </tbody>
        </table>
    </div>
</template>

<style>
.projects-panel {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
}
.projects-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
}
.create-project-form {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
}
.projects-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.92rem;
}
.projects-table th,
.projects-table td {
    text-align: left;
    padding: 0.5rem 0.6rem;
    border-bottom: 1px solid var(--p-content-border-color);
}
.projects-table th {
    color: var(--p-text-muted-color);
    font-weight: 500;
    font-size: 0.82rem;
}
.projects-table td:nth-child(3),
.projects-table td:nth-child(4),
.projects-table td:nth-child(5),
.projects-table th:nth-child(3),
.projects-table th:nth-child(4),
.projects-table th:nth-child(5) {
    text-align: right;
    width: 6rem;
}
.projects-table .action-cell {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    justify-content: flex-end;
    min-width: 14rem;
}
.confirm-text {
    color: var(--p-red-500);
    font-size: 0.85rem;
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
    .rules-explainer {
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
    .projects-table td[data-label="Comments"] {
        color: var(--p-text-muted-color);
        font-size: 0.78rem;
    }
    /* Drop the en-dash placeholder when there's nothing pending —
       on the compact card it just becomes noise next to the counts. */
    .projects-table td[data-label="Pending"] {
        font-size: 0.78rem;
    }
    /* Line 2 — actions forced onto their own row. */
    .projects-table td.action-cell {
        flex: 1 0 100%;
        justify-content: flex-end;
        margin-top: 0.1rem;
        min-width: 0;
    }
}
</style>
