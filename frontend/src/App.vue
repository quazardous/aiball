<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import Select from "primevue/select";
import Drawer from "primevue/drawer";
import Toast from "primevue/toast";
import { useToast } from "primevue/usetoast";
import { api, type Message } from "./lib/api";
import { useWs } from "./lib/ws";
import MessageCard from "./components/MessageCard.vue";
import RulesPanel from "./components/RulesPanel.vue";

const toast = useToast();

type Tab = "pending" | "approved" | "rejected";
const tab = ref<Tab>("pending");
const tabOptions = [
    { label: "Pending", value: "pending" },
    { label: "Approved", value: "approved" },
    { label: "Rejected", value: "rejected" },
];

const projects = ref<string[]>([]);
const project = ref<string | null>(null);
const messages = ref<Message[]>([]);
const loading = ref(false);
const rulesOpen = ref(false);
const dark = ref(false);

const filteredProjects = computed(() => [
    { label: "all projects", value: null },
    ...projects.value.map((p) => ({ label: p, value: p })),
]);

async function loadProjects() {
    try {
        projects.value = await api.listProjects();
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Failed to load projects",
            detail: (e as Error).message,
            life: 4000,
        });
    }
}

async function loadMessages() {
    loading.value = true;
    try {
        messages.value = await api.listMessages({
            status: tab.value,
            project: project.value ?? undefined,
            limit: 200,
        });
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Failed to load messages",
            detail: (e as Error).message,
            life: 4000,
        });
    } finally {
        loading.value = false;
    }
}

function refresh() {
    return Promise.all([loadProjects(), loadMessages()]);
}

function onMessageChanged(updated: Message) {
    const idx = messages.value.findIndex((m) => m.id === updated.id);
    if (updated.status === tab.value) {
        if (idx >= 0) messages.value[idx] = updated;
        else messages.value = [updated, ...messages.value];
    } else {
        if (idx >= 0) messages.value.splice(idx, 1);
    }
}

const { connected } = useWs((ev) => {
    const data = ev.data as Message | undefined;
    if (!data || typeof data !== "object") return;
    if (
        ev.type === "message_decided" ||
        ev.type === "message_edited" ||
        ev.type === "message_noted"
    ) {
        onMessageChanged(data);
    }
});

watch([tab, project], () => loadMessages());

function toggleDark() {
    dark.value = !dark.value;
    document.documentElement.classList.toggle("aiball-dark", dark.value);
}

onMounted(refresh);
</script>

<template>
    <div class="aiball-shell">
        <header class="aiball-header">
            <h1>aiball</h1>
            <span
                class="connection-dot"
                :class="connected ? 'live' : 'offline'"
                :title="connected ? 'WebSocket live' : 'WebSocket offline'"
            />
            <span class="spacer" />
            <Select
                v-model="tab"
                :options="tabOptions"
                option-label="label"
                option-value="value"
            />
            <Select
                v-model="project"
                :options="filteredProjects"
                option-label="label"
                option-value="value"
                placeholder="all projects"
                show-clear
                style="min-width: 12rem"
            />
            <Button
                label="rules"
                icon="pi pi-cog"
                severity="secondary"
                @click="rulesOpen = true"
            />
            <Button
                :icon="dark ? 'pi pi-sun' : 'pi pi-moon'"
                severity="secondary"
                text
                rounded
                @click="toggleDark"
            />
            <Button
                icon="pi pi-refresh"
                severity="secondary"
                text
                rounded
                :loading="loading"
                @click="refresh"
            />
        </header>

        <main class="aiball-main">
            <div v-if="loading && !messages.length" class="aiball-empty">
                Loading…
            </div>
            <div v-else-if="!messages.length" class="aiball-empty">
                <i class="pi pi-inbox" style="font-size: 1.6rem" />
                <div>No {{ tab }} messages{{ project ? ` in ${project}` : "" }}.</div>
            </div>
            <MessageCard
                v-for="m in messages"
                :key="m.id"
                :message="m"
                @changed="onMessageChanged"
            />
        </main>

        <Drawer v-model:visible="rulesOpen" header="Moderation rules" position="right" :style="{ width: 'min(540px, 100vw)' }">
            <RulesPanel />
        </Drawer>

        <Toast />
    </div>
</template>
