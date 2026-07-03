<script setup lang="ts">
/**
 * #457 slice 5.3b — automation rule detail / edit page.
 *
 * Two-mode :
 *   - `new`  : creates a fresh rule via POST.
 *   - `edit` : loads an existing rule and PATCHes the changed fields on save.
 *
 * The editor surface itself lives in `<RuleEditor>` (triggers picker +
 * recursive condition tree + action stack). This component owns the
 * load → seed → save → emit-close orchestration ; it doesn't know
 * about the inner shape of the tree.
 *
 * YAML rules (id < 0) render in a read-only fallback : they live in
 * `.aiball.yaml` and aren't mutated through the API. We surface the
 * compact rendering + a "read-only — edit the file" notice.
 */
import { computed, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import { useConfirm } from "primevue/useconfirm";
import {
    api,
    type AutomationAction,
    type AutomationRule,
    type AutomationTrigger,
    type ConditionTree,
} from "../lib/api";
import { formatActionCompact, formatExpressionCompact } from "../lib/format";
import { bus } from "../lib/bus";
import DetailHeader from "./ui/DetailHeader.vue";
import RuleEditor from "./automation/RuleEditor.vue";

const props = defineProps<{
    /** `"new"` for the create flow, otherwise the rule id as a string. */
    ruleId: string;
}>();
const emit = defineEmits<{
    (e: "close"): void;
}>();

const confirmDialog = useConfirm();
const rule = ref<AutomationRule | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);

const isNew = computed(() => props.ruleId === "new");
const isYaml = computed(() => !isNew.value && Number(props.ruleId) < 0);

async function load() {
    if (isNew.value) {
        rule.value = null;
        return;
    }
    const id = Number(props.ruleId);
    if (!Number.isFinite(id)) {
        error.value = `bad rule id: ${props.ruleId}`;
        return;
    }
    try {
        // No dedicated GET-one endpoint yet — list and find by id. Cheap on
        // a small ruleset ; slice 5.3c may add GET /automation/rules/:id.
        const all = await api.listAutomationRules();
        const found = all.find((r) => r.id === id) ?? null;
        if (!found) {
            error.value = `rule #${id} not found`;
            rule.value = null;
            return;
        }
        rule.value = found;
        error.value = null;
    } catch (e) {
        error.value = (e as Error).message;
    }
}

async function save(patch: {
    triggers: AutomationTrigger[];
    expression: ConditionTree;
    actions: AutomationAction[];
    note: string | null;
}) {
    busy.value = true;
    try {
        if (isNew.value) {
            await api.addAutomationRule({
                triggers: patch.triggers,
                expression: patch.expression,
                actions: patch.actions,
                note: patch.note,
            });
        } else {
            const id = Number(props.ruleId);
            await api.patchAutomationRule(id, {
                triggers: patch.triggers,
                expression: patch.expression,
                actions: patch.actions,
                note: patch.note,
            });
        }
        bus.emit("automation.refresh");
        emit("close");
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        busy.value = false;
    }
}

function del() {
    if (!rule.value || isYaml.value) return;
    // C2 slice 4 — PrimeVue confirm instead of the blocking native dialog.
    confirmDialog.require({
        header: "Delete automation rule",
        message: `Delete automation rule #${rule.value.id}?`,
        icon: "pi pi-trash",
        acceptLabel: "Delete",
        rejectLabel: "Cancel",
        acceptClass: "p-button-danger",
        accept: () => { void doDel(); },
    });
}
async function doDel() {
    if (!rule.value) return;
    busy.value = true;
    try {
        await api.delAutomationRule(rule.value.id);
        bus.emit("automation.refresh");
        emit("close");
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        busy.value = false;
    }
}

watch(() => props.ruleId, () => load());
onMounted(load);

const current = computed(() => {
    if (isNew.value) return "new rule";
    if (isYaml.value) return `yaml #${props.ruleId}`;
    return `#${props.ruleId}`;
});
</script>

<template>
    <div class="aiball-panel rule-detail">
        <DetailHeader
            :crumbs="[{ label: 'Inbox', href: '/' }, { label: 'Automation', href: '/automation' }]"
            :current="current"
            :title="isNew ? 'New automation rule' : `Rule ${current}`"
            @crumb="emit('close')"
        >
            <template v-if="rule && !isNew && !isYaml" #actions>
                <Button
                    icon="pi pi-trash"
                    label="Delete"
                    severity="danger"
                    outlined
                    size="small"
                    :loading="busy"
                    @click="del"
                />
            </template>
        </DetailHeader>

        <div v-if="error" class="aiball-form-error">
            <i class="pi pi-exclamation-triangle" /> {{ error }}
        </div>

        <!-- YAML : read-only fallback. -->
        <template v-if="rule && isYaml">
            <section class="aiball-section rule-detail__yaml">
                <h3>Source : <code>.aiball.yaml</code> (read-only)</h3>
                <p class="aiball-explainer">
                    This rule was loaded from your <code>.aiball.yaml</code>'s
                    <code>automation:</code> block. To change it, edit the file —
                    the daemon re-reads YAML on every event.
                </p>
            </section>
            <section class="aiball-section">
                <h3>Triggers</h3>
                <div class="rule-detail__trigger-row">
                    <span v-for="t in rule.triggers" :key="t" class="trigger-chip">{{ t }}</span>
                </div>
            </section>
            <section class="aiball-section">
                <h3>Condition</h3>
                <pre class="rule-detail__expression">{{ formatExpressionCompact(rule.expression) }}</pre>
            </section>
            <section class="aiball-section">
                <h3>Action{{ rule.actions.length > 1 ? "s" : "" }}</h3>
                <ol class="rule-detail__action-stack">
                    <li v-for="(a, i) in rule.actions" :key="i" class="rule-detail__action">
                        {{ formatActionCompact(a) }}
                    </li>
                </ol>
            </section>
        </template>

        <!-- New or edit : the interactive editor. -->
        <template v-else-if="isNew || rule">
            <RuleEditor
                :rule="rule"
                :busy="busy"
                @save="save"
                @cancel="emit('close')"
            />
        </template>
    </div>
</template>

<style scoped>
.rule-detail__yaml {
    border-left: 3px solid var(--p-blue-500);
}
.rule-detail__expression {
    background: var(--p-surface-100);
    padding: 0.6rem 0.8rem;
    border-radius: 0.3rem;
    font-family: ui-monospace, monospace;
    font-size: 0.95rem;
    white-space: pre-wrap;
    word-break: break-word;
}
.rule-detail__trigger-row {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
}
.trigger-chip {
    background: color-mix(in srgb, var(--p-blue-500) 15%, transparent);
    color: var(--p-blue-600);
    padding: 0.15rem 0.55rem;
    border-radius: 0.3rem;
    font-size: 0.85rem;
    font-family: ui-monospace, monospace;
}
.rule-detail__action-stack {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}
.rule-detail__action {
    font-family: ui-monospace, monospace;
    font-size: 0.95rem;
    background: color-mix(in srgb, var(--p-purple-500) 10%, transparent);
    color: var(--p-purple-600);
    padding: 0.4rem 0.6rem;
    border-radius: 0.3rem;
    display: inline-block;
    width: fit-content;
}
</style>
