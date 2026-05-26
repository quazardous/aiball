<script setup lang="ts">
/**
 * #457 slice 5.3b — top-level rule editor : composes the triggers picker
 * + the recursive condition tree (root = AND container) + the action
 * stack + save/cancel actions.
 *
 * Two modes :
 *   - `new` : called with no `rule` prop. Starts blank ; emits POST on save.
 *   - `edit` : `rule` prop carries the existing AutomationRule. Inputs
 *     pre-populate ; emits PATCH on save.
 *
 * Save / cancel emit upward — the parent (AutomationRuleDetailPage)
 * handles the actual API call + route navigation.
 */
import { computed, ref, watch } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import MultiSelect from "primevue/multiselect";
import type {
    AutomationAction,
    AutomationRule,
    AutomationTrigger,
    ConditionTree,
} from "../../lib/api";
import ContainerBlock from "./ContainerBlock.vue";
import ActionBlock from "./ActionBlock.vue";

const props = defineProps<{
    /** When omitted, we render the "new rule" form. */
    rule?: AutomationRule | null;
    /** Disable the form during a save round-trip. */
    busy?: boolean;
}>();
const emit = defineEmits<{
    (e: "save", patch: {
        triggers: AutomationTrigger[];
        expression: ConditionTree;
        actions: AutomationAction[];
        note: string | null;
    }): void;
    (e: "cancel"): void;
}>();

const triggerOptions: { label: string; value: AutomationTrigger }[] = [
    { label: "ticket created", value: "ticket_created" },
    { label: "ticket tagged", value: "ticket_tagged" },
    { label: "message posted", value: "message_posted" },
    { label: "actionable eval", value: "actionable_eval" },
];

const triggers = ref<AutomationTrigger[]>([]);
const expression = ref<ConditionTree>({ kind: "and", children: [] });
const actions = ref<AutomationAction[]>([
    { kind: "assign", consumer_id: "" },
]);
const note = ref<string>("");
const validationError = ref<string | null>(null);

const isNew = computed(() => !props.rule);

function loadFromProp() {
    if (props.rule) {
        triggers.value = [...props.rule.triggers];
        // Clone the expression to avoid mutating the prop. JSON round-trip
        // is cheap on a small tree and gives us a deep copy without a
        // structuredClone polyfill concern.
        expression.value = JSON.parse(JSON.stringify(props.rule.expression));
        actions.value = JSON.parse(JSON.stringify(props.rule.actions));
        note.value = props.rule.note ?? "";
    } else {
        triggers.value = ["ticket_created", "ticket_tagged"];
        expression.value = { kind: "and", children: [] };
        actions.value = [{ kind: "assign", consumer_id: "" }];
        note.value = "";
    }
    validationError.value = null;
}

watch(() => props.rule?.id, () => loadFromProp(), { immediate: true });

function addAction() {
    actions.value = [...actions.value, { kind: "assign", consumer_id: "" }];
}
function updateAction(index: number, a: AutomationAction) {
    const next = [...actions.value];
    next[index] = a;
    actions.value = next;
}
function removeAction(index: number) {
    if (actions.value.length === 1) {
        validationError.value = "A rule needs at least one action.";
        return;
    }
    actions.value = actions.value.filter((_, i) => i !== index);
}

function save() {
    if (triggers.value.length === 0) {
        validationError.value = "Pick at least one trigger.";
        return;
    }
    if (actions.value.length === 0) {
        validationError.value = "A rule needs at least one action.";
        return;
    }
    // Light validation : leaves with empty string values may be intentional
    // (operator hasn't finished typing) but the server-side validateConditionTree
    // doesn't reject them — only structural errors. Let the server take it
    // from here. Same for `actions[i].consumer_id` empty → server returns 400
    // with the index hint.
    validationError.value = null;
    emit("save", {
        triggers: triggers.value,
        expression: expression.value,
        actions: actions.value,
        note: note.value.trim() === "" ? null : note.value,
    });
}
</script>

<template>
    <div class="rule-editor">
        <section class="aiball-section rule-editor__triggers">
            <h3>Triggers</h3>
            <p class="aiball-explainer aiball-explainer--muted">
                Pick one or more lifecycle events. The rule fires for ANY of the
                selected triggers (union — david `8r7crj`).
            </p>
            <MultiSelect
                v-model="triggers"
                :options="triggerOptions"
                option-label="label"
                option-value="value"
                placeholder="select triggers"
                class="rule-editor__triggers-input"
                :disabled="busy"
            />
        </section>

        <section class="aiball-section">
            <h3>Conditions</h3>
            <p class="aiball-explainer aiball-explainer--muted">
                Compose with <strong>AND / OR / NOT</strong> groups. The root is an
                ALL-of (AND) group ; an empty root means the rule matches
                everything.
            </p>
            <ContainerBlock
                v-if="expression.kind !== 'leaf'"
                :node="expression"
                :removable="false"
                @update="(n) => expression = n"
                @remove="expression = { kind: 'and', children: [] }"
            />
        </section>

        <section class="aiball-section">
            <h3>Actions</h3>
            <p class="aiball-explainer aiball-explainer--muted">
                Run in order on every match. Errors in one don't abort the rest
                (david `2r3w6a` : fail-isolated).
            </p>
            <div class="rule-editor__actions-stack">
                <ActionBlock
                    v-for="(a, i) in actions"
                    :key="i"
                    :action="a"
                    @update="(act) => updateAction(i, act)"
                    @remove="removeAction(i)"
                />
            </div>
            <div class="rule-editor__action-add">
                <Button
                    icon="pi pi-plus"
                    label="add action"
                    text
                    size="small"
                    :disabled="busy"
                    @click="addAction"
                />
            </div>
        </section>

        <section class="aiball-section">
            <h3>Note (optional)</h3>
            <p class="aiball-explainer aiball-explainer--muted">
                Custom label shown in the rules list. Leave empty to let the list
                auto-generate one from the compact expression.
            </p>
            <InputText
                v-model="note"
                placeholder="(auto-generated from the expression)"
                class="w-full"
                :disabled="busy"
            />
        </section>

        <div v-if="validationError" class="aiball-form-error">
            <i class="pi pi-exclamation-triangle" /> {{ validationError }}
        </div>

        <div class="rule-editor__form-actions">
            <Button
                label="cancel"
                text
                :disabled="busy"
                @click="emit('cancel')"
            />
            <Button
                :label="isNew ? 'create rule' : 'save'"
                icon="pi pi-save"
                :loading="busy"
                @click="save"
            />
        </div>
    </div>
</template>

<style scoped>
.rule-editor {
    display: flex;
    flex-direction: column;
    gap: 1.2rem;
}
.rule-editor__triggers-input {
    min-width: 22rem;
    max-width: 32rem;
}
.rule-editor__actions-stack {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}
.rule-editor__action-add {
    margin-top: 0.4rem;
}
.rule-editor__form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--p-content-border-color);
}
</style>
