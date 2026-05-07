<script setup lang="ts">
import { ref, onMounted } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import ToggleSwitch from "primevue/toggleswitch";
import Tag from "primevue/tag";
import { api, type Rule } from "../lib/api";

const rules = ref<Rule[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);

const decision = ref<"auto" | "review">("auto");
const matchProject = ref("");
const matchKind = ref<string | null>(null);
const matchBy = ref("");
const note = ref("");

const decisionOptions = [
    { label: "auto-approve", value: "auto" },
    { label: "send to review", value: "review" },
];

const kindOptions = [
    { label: "(any)", value: null },
    { label: "ticket_created", value: "ticket_created" },
    { label: "comment_added", value: "comment_added" },
    { label: "ticket_closed", value: "ticket_closed" },
];

async function load() {
    try {
        rules.value = await api.listRules();
        error.value = null;
    } catch (e) {
        error.value = (e as Error).message;
    }
}

async function add() {
    busy.value = true;
    try {
        await api.addRule({
            decision: decision.value,
            match_project: matchProject.value || null,
            match_kind: matchKind.value || null,
            match_by_agent: matchBy.value || null,
            note: note.value || null,
        });
        matchProject.value = "";
        matchBy.value = "";
        matchKind.value = null;
        note.value = "";
        await load();
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        busy.value = false;
    }
}

async function toggle(r: Rule, enabled: boolean) {
    try {
        await api.toggleRule(r.id, enabled);
        await load();
    } catch (e) {
        error.value = (e as Error).message;
    }
}

async function del(r: Rule) {
    if (!confirm(`Delete rule #${r.id}?`)) return;
    try {
        await api.delRule(r.id);
        await load();
    } catch (e) {
        error.value = (e as Error).message;
    }
}

defineExpose({ load });
onMounted(load);
</script>

<template>
    <div class="rules-panel">
        <div v-for="r in rules" :key="r.id" class="rule-row" :class="{ disabled: !r.enabled }">
            <Tag
                :value="r.decision"
                :severity="r.decision === 'auto' ? 'success' : 'warn'"
            />
            <div>
                <strong>#{{ r.id }}</strong>
                <span v-if="r.match_project"> · project=<em>{{ r.match_project }}</em></span>
                <span v-if="r.match_kind"> · kind=<em>{{ r.match_kind }}</em></span>
                <span v-if="r.match_by_agent"> · by=<em>{{ r.match_by_agent }}</em></span>
                <span v-if="!r.match_project && !r.match_kind && !r.match_by_agent">
                    · (matches everything)
                </span>
                <div v-if="r.note" style="opacity: 0.7; font-size: 0.85rem">
                    {{ r.note }}
                </div>
            </div>
            <div style="display: flex; gap: 0.4rem; align-items: center">
                <ToggleSwitch
                    :model-value="!!r.enabled"
                    @update:model-value="(v) => toggle(r, !!v)"
                />
                <Button
                    icon="pi pi-trash"
                    size="small"
                    severity="danger"
                    text
                    @click="del(r)"
                />
            </div>
        </div>

        <div v-if="!rules.length" class="aiball-empty">No rules — everything goes to review.</div>

        <div class="rule-form">
            <div>
                <span class="field-label">Decision</span>
                <Select
                    v-model="decision"
                    :options="decisionOptions"
                    option-label="label"
                    option-value="value"
                />
            </div>
            <div>
                <span class="field-label">Project</span>
                <InputText v-model="matchProject" placeholder="(any)" />
            </div>
            <div>
                <span class="field-label">Kind</span>
                <Select
                    v-model="matchKind"
                    :options="kindOptions"
                    option-label="label"
                    option-value="value"
                />
            </div>
            <div>
                <span class="field-label">By agent</span>
                <InputText v-model="matchBy" placeholder="(any)" />
            </div>
            <div>
                <span class="field-label">Note</span>
                <InputText v-model="note" placeholder="optional" />
            </div>
            <div>
                <Button
                    label="add rule"
                    icon="pi pi-plus"
                    :loading="busy"
                    @click="add"
                />
            </div>
        </div>

        <div v-if="error" style="color: var(--p-red-500)">
            <i class="pi pi-exclamation-triangle" /> {{ error }}
        </div>
    </div>
</template>
