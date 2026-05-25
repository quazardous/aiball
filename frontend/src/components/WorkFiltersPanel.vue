<script setup lang="ts">
// #447: per-agent work filters — narrow which tickets an agent picks up, by
// tag. Server-side gate; this panel just CRUDs the rules (stored in the daemon
// DB, so a loop on any machine sees them). Reuses the global .rules-* styles
// from RulesPanel for a consistent look.
import { computed, onMounted, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import ToggleSwitch from "primevue/toggleswitch";
import { api, type WorkFilter } from "../lib/api";

const filters = ref<WorkFilter[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);

const consumer = ref("");
const project = ref("");
const mode = ref<"only" | "except">("only");
const tagsInput = ref("");
const note = ref("");

const modeOptions = [
    { label: "work ONLY these", value: "only" },
    { label: "NEVER work these", value: "except" },
];

const sorted = computed(() =>
    [...filters.value].sort((a, b) => a.position - b.position || a.id - b.id),
);

async function load() {
    try {
        filters.value = await api.listWorkFilters();
        error.value = null;
    } catch (e) {
        error.value = (e as Error).message;
    }
}

function parseTags(s: string): string[] {
    return s.split(",").map((t) => t.trim()).filter(Boolean);
}

async function add() {
    const tags = parseTags(tagsInput.value);
    if (!consumer.value.trim()) { error.value = "agent (consumer id) is required"; return; }
    if (tags.length === 0) { error.value = "list at least one tag"; return; }
    busy.value = true;
    try {
        await api.addWorkFilter({
            consumer_id: consumer.value.trim(),
            project: project.value.trim() || null,
            mode: mode.value,
            match_tags: tags,
            note: note.value || null,
        });
        consumer.value = "";
        project.value = "";
        tagsInput.value = "";
        note.value = "";
        mode.value = "only";
        await load();
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        busy.value = false;
    }
}

async function toggle(f: WorkFilter, enabled: boolean) {
    try {
        await api.toggleWorkFilter(f.id, enabled);
        await load();
    } catch (e) {
        error.value = (e as Error).message;
    }
}

async function del(f: WorkFilter) {
    if (!confirm(`Delete work filter #${f.id}?`)) return;
    try {
        await api.delWorkFilter(f.id);
        await load();
    } catch (e) {
        error.value = (e as Error).message;
    }
}

onMounted(load);
</script>

<template>
    <div class="rules-page">
        <header class="rules-header">
            <h2>Work filters</h2>
            <p class="rules-explainer">
                Narrow which tickets an <strong>agent</strong> picks up, by tag. e.g.
                <em>the windows agent only works tickets tagged <code>win</code></em>.
                These restrict an agent's <strong>engage / actionable</strong> pool — they never
                hide tickets from your own view.
            </p>
            <p class="rules-explainer rules-explainer--muted">
                Filters live in the daemon, so an agent's loop on <em>any</em> machine that talks to
                this daemon picks them up — no per-machine config to sync. Tags match
                <strong>any-of</strong>: a ticket matches when it carries at least one listed tag.
            </p>
        </header>

        <section class="rules-section">
            <div class="rules-section-head">
                <h3>Active filters ({{ sorted.length }})</h3>
            </div>

            <div v-if="!sorted.length" class="aiball-empty">
                No work filters yet. Every agent works its full actionable pool.
            </div>

            <ol class="rule-list">
                <li
                    v-for="f in sorted"
                    :key="f.id"
                    class="rule-item"
                    :class="{ disabled: !f.enabled }"
                >
                    <div class="rule-rank"><i class="pi pi-filter" /></div>
                    <div class="rule-body">
                        <div class="rule-sentence">
                            <span class="cond">
                                <span class="cond-label">agent</span>
                                <span class="cond-eq">=</span>
                                <span class="cond-value">{{ f.consumer_id }}</span>
                            </span>
                            <template v-if="f.project">
                                <span class="kw kw-and">in</span>
                                <span class="cond">
                                    <span class="cond-label">project</span>
                                    <span class="cond-eq">=</span>
                                    <span class="cond-value">{{ f.project }}</span>
                                </span>
                            </template>
                            <span class="kw">→</span>
                            <span
                                class="verdict"
                                :class="f.mode === 'only' ? 'verdict-auto' : 'verdict-review'"
                            >
                                {{ f.mode === "only" ? "works ONLY" : "never works" }}
                            </span>
                            <span class="kw">tickets tagged</span>
                            <span v-for="t in f.match_tags" :key="t" class="cond cond-value">{{ t }}</span>
                        </div>
                        <div v-if="f.note" class="rule-note">
                            <i class="pi pi-info-circle" />
                            <em>{{ f.note }}</em>
                        </div>
                        <div class="rule-id">filter #{{ f.id }}</div>
                    </div>
                    <div class="rule-controls">
                        <ToggleSwitch
                            :model-value="!!f.enabled"
                            @update:model-value="(v) => toggle(f, !!v)"
                        />
                        <Button
                            icon="pi pi-trash"
                            severity="danger"
                            text
                            rounded
                            size="small"
                            @click="del(f)"
                        />
                    </div>
                </li>
            </ol>
        </section>

        <section class="rules-section">
            <h3>Add a filter</h3>
            <p class="rules-explainer rules-explainer--muted">
                <em>this agent</em> [in <em>this project</em>] <em>only / never</em> works tickets
                carrying <em>these tags</em>.
            </p>
            <div class="rule-builder">
                <div class="builder-cond">
                    <label class="field-label">agent (consumer id)</label>
                    <InputText v-model="consumer" placeholder="e.g. aiball-win-claude" class="w-full" />
                </div>
                <div class="builder-cond">
                    <label class="field-label">project (optional)</label>
                    <InputText v-model="project" placeholder="(all projects)" class="w-full" />
                </div>
                <div class="builder-cond">
                    <label class="field-label">mode</label>
                    <Select
                        v-model="mode"
                        :options="modeOptions"
                        option-label="label"
                        option-value="value"
                        class="w-full"
                    />
                </div>
                <div class="builder-cond" style="flex: 1; min-width: 12rem">
                    <label class="field-label">tags (comma-separated, any-of)</label>
                    <InputText v-model="tagsInput" placeholder="win, urgent" class="w-full" />
                </div>
            </div>
            <div class="builder-row">
                <div class="builder-cond" style="flex: 1">
                    <label class="field-label">note (optional, shown in the list)</label>
                    <InputText v-model="note" placeholder="why this filter exists" class="w-full" />
                </div>
                <Button
                    label="add filter"
                    icon="pi pi-plus"
                    :loading="busy"
                    @click="add"
                />
            </div>
        </section>

        <div v-if="error" class="rules-error">
            <i class="pi pi-exclamation-triangle" /> {{ error }}
        </div>
    </div>
</template>
