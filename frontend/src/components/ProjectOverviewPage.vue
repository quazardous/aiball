<script setup lang="ts">
/**
 * #471 — unified project overview page : Tabs(Detail / Stats / Settings)
 * + Danger zone (Delete / Purge). Replaces the per-row icons in the
 * projects list (gear / chart / monitor / eraser / trash) — the row
 * is now clickable as a whole and lands here. The existing pages
 * (ProjectDetailPage, ProjectStatsPage, ProjectSettingsPage) stay
 * deep-linkable on their /detail, /stats, /settings routes for
 * back-compat, but the canonical entry is now /overview.
 *
 * Each tab embeds its underlying page with `embedded=true` so the
 * page's own DetailHeader is suppressed — we own the breadcrumb here.
 *
 * The Settings tab gains a "Danger zone" section : Delete / Purge old
 * tickets, both with ConfirmDialog gating (no inline confirm-text). It
 * absorbs the actions that lived in the list rows.
 */
import { ref } from "vue";
import Button from "primevue/button";
import Tab from "primevue/tab";
import TabList from "primevue/tablist";
import TabPanel from "primevue/tabpanel";
import TabPanels from "primevue/tabpanels";
import Tabs from "primevue/tabs";
import { useToast } from "primevue/usetoast";
import { useConfirm } from "primevue/useconfirm";
import { api } from "../lib/api";
import { bus } from "../lib/bus";
import DetailHeader from "./ui/DetailHeader.vue";
import ProjectDetailPage from "./ProjectDetailPage.vue";
import ProjectStatsPage from "./ProjectStatsPage.vue";
import ProjectSettingsPage from "./ProjectSettingsPage.vue";

const props = defineProps<{ project: string }>();
const emit = defineEmits<{
    (e: "close"): void;
}>();

const activeTab = ref<"detail" | "stats" | "settings">("detail");
const toast = useToast();
const confirmDialog = useConfirm();
const purging = ref(false);

// #699 david — project deletion was removed from the UI ; destructive
// project ops are CLI-only now (`aiball project delete <name>`,
// `aiball project rename <old> <new>`). The danger-zone purge below
// stays in-UI because it only removes OLD closed rows, not the project
// itself.

function confirmPurge() {
    confirmDialog.require({
        header: "Purge old closed tickets",
        message: `Purge tickets closed more than 1 year ago in "${props.project}"? Open tickets, comments on still-open tickets, and recently-closed tickets are left intact.`,
        icon: "pi pi-eraser",
        acceptLabel: "Purge",
        rejectLabel: "Cancel",
        acceptClass: "p-button-warn",
        accept: () => { void doPurge(); },
    });
}
async function doPurge() {
    purging.value = true;
    try {
        const r = await api.purgeOldClosed(props.project, 365);
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
        purging.value = false;
    }
}
</script>

<template>
    <div class="project-overview">
        <DetailHeader
            :crumbs="[{ label: 'Inbox', href: '/' }, { label: 'Projects', href: '/projects' }]"
            :current="project"
            title="Project overview"
            @crumb="emit('close')"
        />

        <Tabs v-model:value="activeTab">
            <TabList>
                <Tab value="detail">Detail</Tab>
                <Tab value="stats">Stats</Tab>
                <Tab value="settings">Settings</Tab>
            </TabList>
            <TabPanels>
                <TabPanel value="detail">
                    <ProjectDetailPage
                        v-if="activeTab === 'detail'"
                        :project="project"
                        :embedded="true"
                        @back="emit('close')"
                    />
                </TabPanel>
                <TabPanel value="stats">
                    <ProjectStatsPage
                        v-if="activeTab === 'stats'"
                        :project="project"
                        :embedded="true"
                        @back="emit('close')"
                    />
                </TabPanel>
                <TabPanel value="settings">
                    <ProjectSettingsPage
                        v-if="activeTab === 'settings'"
                        :project="project"
                        :embedded="true"
                        @back="emit('close')"
                    />
                    <!-- #471 — Danger zone : absorbed from the per-row
                         actions david retired. Settings tab is the natural
                         home — destructive ops live next to the project's
                         config knobs. -->
                    <section v-if="activeTab === 'settings'" class="project-overview__danger">
                        <h3>Danger zone</h3>
                        <p class="aiball-explainer aiball-explainer--muted">
                            Bulk maintenance on this project. Use
                            <code>aiball project delete &lt;name&gt;</code> or
                            <code>aiball project rename &lt;old&gt; &lt;new&gt;</code>
                            from a terminal for destructive ops on the project itself
                            (#699 — moved to CLI to avoid stray clicks).
                        </p>
                        <div class="project-overview__danger-actions">
                            <Button
                                icon="pi pi-eraser"
                                label="Purge tickets closed > 1 year"
                                severity="warn"
                                outlined
                                :loading="purging"
                                @click="confirmPurge"
                            />
                        </div>
                    </section>
                </TabPanel>
            </TabPanels>
        </Tabs>
    </div>
</template>

<style scoped>
.project-overview {
    display: flex;
    flex-direction: column;
    gap: 1rem;
}
.project-overview__danger {
    margin-top: 1.5rem;
    padding: 1rem 1.2rem;
    border: 1px solid color-mix(in srgb, var(--p-red-500) 25%, var(--p-content-border-color));
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--p-red-500) 3%, transparent);
}
.project-overview__danger h3 {
    margin-top: 0;
    color: var(--p-red-600);
}
.project-overview__danger-actions {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin-top: 0.6rem;
}
</style>
