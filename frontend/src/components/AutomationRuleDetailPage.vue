<script setup lang="ts">
/**
 * #457 slice 5.3a — automation rule detail / edit page. Loaded when the
 * URL is `/automation/rules/<id>` or `/automation/rules/new`. Renders
 * inside `<AutomationPanel>` instead of the rules list.
 *
 * This slice (5.3a) ships the SCAFFOLDING : DetailHeader breadcrumb, the
 * rule's current shape rendered read-only as compact summaries, and an
 * explicit "WIP" notice pointing to slice 5.3b for the actual block-based
 * editor. Save / Delete still call the API but only the metadata fields
 * (note, enabled toggle) are editable here — the expression tree + action
 * picker are READ-ONLY until 5.3b lands.
 *
 * Why this scaffold first : it lets the list page get its "Edit" button
 * + "+ new rule" navigation right NOW (slice 5.3a's main visible change)
 * without holding it hostage to the full block-editor's ~400 lines of
 * recursive UI. The detail page is small here ; 5.3b fills the editor
 * slot.
 */
import { computed, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import ToggleSwitch from "primevue/toggleswitch";
import {
    api,
    type AutomationRule,
} from "../lib/api";
import { formatActionCompact, formatExpressionCompact } from "../lib/format";
import { bus } from "../lib/bus";
import DetailHeader from "./ui/DetailHeader.vue";
import FieldRow from "./ui/FieldRow.vue";

const props = defineProps<{
    /** `"new"` for the create flow, otherwise the rule id as a string. */
    ruleId: string;
}>();
const emit = defineEmits<{
    (e: "close"): void;
}>();

const rule = ref<AutomationRule | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const noteDraft = ref("");

const isNew = computed(() => props.ruleId === "new");
const isYaml = computed(() => !isNew.value && Number(props.ruleId) < 0);

async function load() {
    if (isNew.value) {
        rule.value = null;
        noteDraft.value = "";
        return;
    }
    const id = Number(props.ruleId);
    if (!Number.isFinite(id)) {
        error.value = `bad rule id: ${props.ruleId}`;
        return;
    }
    try {
        // No dedicated GET-one endpoint yet — list and find by id. Cheap on
        // a small ruleset ; slice 5.3b adds GET /automation/rules/:id.
        const all = await api.listAutomationRules();
        const found = all.find((r) => r.id === id) ?? null;
        if (!found) {
            error.value = `rule #${id} not found`;
            rule.value = null;
            return;
        }
        rule.value = found;
        noteDraft.value = found.note ?? "";
        error.value = null;
    } catch (e) {
        error.value = (e as Error).message;
    }
}

async function toggleEnabled(v: boolean) {
    if (!rule.value || isYaml.value) return;
    busy.value = true;
    try {
        const updated = await api.toggleAutomationRule(rule.value.id, v);
        rule.value = updated;
        bus.emit("automation.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        busy.value = false;
    }
}

async function del() {
    if (!rule.value || isYaml.value) return;
    if (!confirm(`Delete automation rule #${rule.value.id}?`)) return;
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
        />

        <div v-if="error" class="aiball-form-error">
            <i class="pi pi-exclamation-triangle" /> {{ error }}
        </div>

        <section v-if="isNew" class="aiball-section rule-detail__wip">
            <h3>Slice 5.3b WIP</h3>
            <p class="aiball-explainer">
                The block-based editor (trigger picker, recursive condition tree
                with field-typed blocks, action picker) lands in slice 5.3b. For
                now, create rules via the API or YAML :
            </p>
            <pre class="rule-detail__code">curl --unix-socket ~/.local/share/aiball/sock \
  -X POST http://localhost/api/automation/rules \
  -H "content-type: application/json" \
  -d '{
    "triggers": ["ticket_created","ticket_tagged"],
    "expression": {
      "kind":"leaf","field":"tags","op":"includes","value":"win"
    },
    "action": {"kind":"assign","consumer_id":"aiball-windows"}
  }'</pre>
            <p class="aiball-explainer aiball-explainer--muted">
                Or add an <code>automation:</code> block to your <code>.aiball.yaml</code>.
            </p>
        </section>

        <template v-else-if="rule">
            <section class="aiball-section">
                <h3>Triggers</h3>
                <div class="rule-detail__trigger-row">
                    <span v-for="t in rule.triggers" :key="t" class="trigger-chip">{{ t }}</span>
                    <span v-if="rule.triggers.length === 0" class="aiball-empty">
                        (no triggers — rule never fires)
                    </span>
                </div>
            </section>

            <section class="aiball-section">
                <h3>Condition expression</h3>
                <pre class="rule-detail__expression">{{ formatExpressionCompact(rule.expression) }}</pre>
                <p class="aiball-explainer aiball-explainer--muted">
                    Read-only here ; the block-based editor lands in slice 5.3b.
                </p>
            </section>

            <section class="aiball-section">
                <h3>Action</h3>
                <p class="rule-detail__action">{{ formatActionCompact(rule.action) }}</p>
            </section>

            <section class="aiball-section">
                <h3>Metadata</h3>
                <FieldRow v-if="!isYaml" label="Note (label shown in the list)">
                    <InputText
                        v-model="noteDraft"
                        placeholder="(auto-generated from the expression)"
                        class="w-full"
                        :disabled="busy"
                    />
                </FieldRow>
                <FieldRow label="Enabled">
                    <ToggleSwitch
                        :model-value="!!rule.enabled"
                        :disabled="busy || isYaml"
                        @update:model-value="(v) => toggleEnabled(!!v)"
                    />
                </FieldRow>
                <FieldRow label="Position">
                    <span class="aiball-explainer aiball-explainer--muted">{{ rule.position }} (first-match-wins ordering)</span>
                </FieldRow>
                <FieldRow label="Created">
                    <span class="aiball-explainer aiball-explainer--muted">{{ rule.created_at }}</span>
                </FieldRow>
                <FieldRow v-if="isYaml" label="Source">
                    <span class="source-badge"><i class="pi pi-file" /> .aiball.yaml — read-only</span>
                </FieldRow>
            </section>

            <section v-if="!isYaml" class="aiball-section rule-detail__danger">
                <Button
                    icon="pi pi-trash"
                    severity="danger"
                    label="Delete rule"
                    :loading="busy"
                    outlined
                    @click="del"
                />
            </section>
        </template>
    </div>
</template>

<style scoped>
.rule-detail__wip {
    border-left: 3px solid var(--p-orange-500);
}
.rule-detail__code {
    background: var(--p-surface-100);
    color: var(--p-text-color);
    padding: 0.8rem;
    border-radius: 0.3rem;
    overflow-x: auto;
    font-size: 0.85rem;
    font-family: ui-monospace, monospace;
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
.rule-detail__action {
    font-family: ui-monospace, monospace;
    font-size: 0.95rem;
    background: color-mix(in srgb, var(--p-purple-500) 10%, transparent);
    color: var(--p-purple-600);
    padding: 0.4rem 0.6rem;
    border-radius: 0.3rem;
    display: inline-block;
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
.source-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: color-mix(in srgb, var(--p-blue-500) 15%, transparent);
    color: var(--p-blue-600);
    padding: 0.15rem 0.55rem;
    border-radius: 0.3rem;
    font-size: 0.85rem;
}
.rule-detail__danger {
    margin-top: 1.5rem;
}
</style>
