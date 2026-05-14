<script setup lang="ts">
/**
 * Dedicated page for creating a new ticket (per #B.298). Hosted at
 * `/new` via the router. Was previously an inline expansion on the
 * inbox toolbar — the inline form forced the user to pre-select a
 * project from the sidebar before they could compose. This page
 * exposes the project as a first-class field so the writer picks
 * the destination as part of the same flow.
 *
 * Behaviour:
 *   - Lists every known project in a dropdown (plus an "(other)"
 *     option that reveals a free-text input for new projects).
 *   - Pre-selects the current project from URL state if set, falling
 *     back to the saved aiball.compose.last_project.
 *   - Submits via MessageComposer; on success, navigates to the
 *     freshly-created thread (or back to the inbox if the API didn't
 *     return an id — defensive).
 *   - "back" / "cancel" pops the user back to the inbox.
 */
import { computed, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import { api, type ProjectMeta } from "../lib/api";
import { bus } from "../lib/bus";
import MessageComposer from "./MessageComposer.vue";

const props = defineProps<{
    /** Initial project — comes from the URL `?p=` or the sidebar state. */
    initialProject?: string | null;
}>();
const emit = defineEmits<{
    (e: "submitted", ticketId: number | null): void;
    (e: "back"): void;
}>();

const projects = ref<ProjectMeta[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const SENTINEL_OTHER = "__other__";
const projectChoice = ref<string>(SENTINEL_OTHER);
const newProjectName = ref("");
const composerBody = ref("");

/** Final project name used when posting — resolved from the dropdown
 *  + the "(other)" text input. Trimmed; empty if invalid. */
const resolvedProject = computed(() => {
    if (projectChoice.value === SENTINEL_OTHER) {
        return newProjectName.value.trim();
    }
    return projectChoice.value;
});

const projectOptions = computed(() => [
    ...projects.value.map((p) => ({
        label: p.name,
        value: p.name,
    })),
    { label: "(other — new project)", value: SENTINEL_OTHER },
]);

async function loadProjects() {
    loading.value = true;
    try {
        const list = await api.listProjectsDetailed(
            localStorage.getItem("aiball.human_id") ?? "human",
        );
        projects.value = list;
        // Seed the project choice with the best available default.
        const fromUrl = props.initialProject;
        const lastUsed = localStorage.getItem("aiball.compose.last_project");
        const candidate = fromUrl ?? lastUsed ?? null;
        if (
            candidate &&
            projects.value.some((p) => p.name === candidate)
        ) {
            projectChoice.value = candidate;
        } else if (projects.value.length > 0) {
            projectChoice.value = projects.value[0].name;
        } else {
            projectChoice.value = SENTINEL_OTHER;
        }
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        loading.value = false;
    }
}

onMounted(loadProjects);

// Keep "last used" sticky so a power user creating several tickets on
// the same project doesn't re-pick it each time.
watch(projectChoice, (v) => {
    if (v && v !== SENTINEL_OTHER) {
        localStorage.setItem("aiball.compose.last_project", v);
    }
});

function onComposerSubmitted(messageId: number | null) {
    // The composer fires the bus events; forward the newly-created
    // ticket id so App.vue can open the thread instead of bouncing
    // back to the inbox (#B.98).
    bus.emit("inbox.refresh");
    bus.emit("projects.refresh");
    emit("submitted", messageId);
}
</script>

<template>
    <div class="new-ticket-page">
        <div class="new-ticket-toolbar">
            <Button
                icon="pi pi-arrow-left"
                label="back"
                severity="secondary"
                text
                size="small"
                @click="emit('back')"
            />
            <h2 class="new-ticket-title">New ticket</h2>
            <span class="spacer" />
        </div>

        <div v-if="error" class="aiball-empty" style="color: var(--p-red-500)">
            {{ error }}
        </div>

        <div v-else class="new-ticket-form">
            <div class="new-ticket-row">
                <label class="new-ticket-label">Project</label>
                <Select
                    v-model="projectChoice"
                    :options="projectOptions"
                    option-label="label"
                    option-value="value"
                    :disabled="loading"
                    size="small"
                    class="new-ticket-project-select"
                    placeholder="Choose a project"
                />
                <InputText
                    v-if="projectChoice === SENTINEL_OTHER"
                    v-model="newProjectName"
                    placeholder="new-project-name"
                    size="small"
                    class="new-ticket-project-input"
                />
            </div>

            <div
                v-if="!resolvedProject"
                class="new-ticket-hint"
            >
                Pick an existing project or type a new project name to
                continue.
            </div>

            <MessageComposer
                v-if="resolvedProject"
                v-model:body="composerBody"
                mode="ticket"
                :project="resolvedProject"
                submit-label="post ticket"
                @submitted="onComposerSubmitted"
            />
        </div>
    </div>
</template>

<style>
.new-ticket-page {
    display: flex;
    flex-direction: column;
    gap: 1rem;
}
.new-ticket-toolbar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
}
.new-ticket-title {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 600;
}
.new-ticket-form {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
}
.new-ticket-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
}
.new-ticket-label {
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
    min-width: 5rem;
}
.new-ticket-project-select {
    min-width: 14rem;
}
.new-ticket-project-input {
    min-width: 14rem;
}
.new-ticket-hint {
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
    padding: 0.5rem 0.7rem;
    background: var(--p-surface-50);
    border-left: 3px solid var(--p-content-border-color);
    border-radius: 0.3rem;
}
.aiball-dark .new-ticket-hint {
    background: var(--p-surface-900);
}
</style>
