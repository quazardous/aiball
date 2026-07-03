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
import { computed, onMounted, provide, ref, watch } from "vue";
import { stringify as yamlStringify } from "yaml";
import { createLeafSources, LEAF_SOURCES_KEY } from "../../lib/leaf-sources";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Menu from "primevue/menu";
import MultiSelect from "primevue/multiselect";
import Tab from "primevue/tab";
import TabList from "primevue/tablist";
import TabPanel from "primevue/tabpanel";
import TabPanels from "primevue/tabpanels";
import Tabs from "primevue/tabs";
import type {
    AutomationAction,
    AutomationRule,
    AutomationTrigger,
    ConditionTree,
} from "../../lib/api";
import ConditionNode from "./ConditionNode.vue";
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
    // #509 — state-change triggers : fire chaque fois qu'un ticket existant
    // voit son attribut structurel muter (priorité, project, status).
    { label: "ticket priority changed", value: "ticket_priority_changed" },
    { label: "ticket project changed", value: "ticket_project_changed" },
    { label: "ticket status changed", value: "ticket_status_changed" },
    { label: "message posted", value: "message_posted" },
    { label: "actionable eval", value: "actionable_eval" },
];

const triggers = ref<AutomationTrigger[]>([]);
// #457 david `5g7ngx` : "la condition de base devrait etre vide (si on
// veut commencer par not ou quoi)". A new rule starts with NO root → the
// builder shows a "Pick your first block" menu so the user can choose
// AND / OR / NOT / single leaf as the starting shape. Existing rules
// load their actual expression. On save, null collapses to the empty
// `{ kind: "and", children: [] }` (matches everything) for wire shape.
const expression = ref<ConditionTree | null>(null);
const actions = ref<AutomationAction[]>([
    { kind: "assign", consumer_id: "" },
]);
const note = ref<string>("");
const validationError = ref<string | null>(null);

const isNew = computed(() => !props.rule);

// #457 david `5muwmt` : "l'éditeur devrait avoir 2 tabulation : builder
// graphique + code équivalent". Tab 1 = the block-based form ; Tab 2 =
// the equivalent JSON view of the current draft. Slice 5.3c-MVP : Code
// tab is READ-ONLY (you can copy/paste it into curl or a YAML file, but
// edits go through the Builder for now — a slice 5.3d can add a "Apply"
// button that parses the JSON back into the draft).
const activeView = ref<"builder" | "code">("builder");
// #519 — code tab en YAML, directement copiable dans le bloc `automation:`
// d'un `.aiball.yaml`. Le backend yaml parser accepte la shape
// canonique (triggers + expression tree + actions[]). Pour les rules
// simples (AND-tree de leaves `eq`), on dump le sucre legacy `when:`/`do:`
// — sinon shape canonique.
const codeSnapshot = computed<string>(() => {
    const exprForCol = expression.value ?? { kind: "and", children: [] };
    const payload: Record<string, unknown> = {
        triggers: triggers.value,
        expression: exprForCol,
        actions: actions.value,
    };
    if (note.value.trim() !== "") payload.note = note.value;
    // yaml lib dump : indent default 2, line wrap off pour lisibilité ;
    // garde le booléen `true/false` (pas `~`), strings en plain quand
    // possible.
    const yamlBody = yamlStringify(payload, {
        indent: 2,
        lineWidth: 0,
    }).trimEnd();
    // Préfixe `- ` pour matcher la shape attendue dans un bloc
    // `automation:` (liste de rules). L'utilisateur colle le bloc tel quel
    // sous `automation:` dans `.aiball.yaml`.
    const indented = yamlBody.split("\n").map((l, i) => i === 0 ? `  - ${l}` : `    ${l}`).join("\n");
    return `automation:\n${indented}\n`;
});

// Menu for the "first block" picker shown when expression is null. The
// same shape as ContainerBlock's add menu, but at the root level. Each
// command sets expression.value to the chosen starting shape.
const rootMenu = ref();
const rootMenuItems = [
    {
        label: "Condition (single leaf)",
        icon: "pi pi-bolt",
        command: () => { expression.value = { kind: "leaf", field: "project", op: "in", value: [] }; },
    },
    {
        label: "ALL of (AND group)",
        icon: "pi pi-th-large",
        command: () => { expression.value = { kind: "and", children: [] }; },
    },
    {
        label: "ANY of (OR group)",
        icon: "pi pi-th-large",
        command: () => { expression.value = { kind: "or", children: [] }; },
    },
    {
        label: "NOT (negation)",
        icon: "pi pi-ban",
        command: () => {
            // david (#498) : NOT vient avec un AND vide, pas un leaf —
            // l'utilisateur peut alors choisir la forme du contenu
            // (toggle AND/OR via le Select interne, +add pour
            // poser un leaf ou nester un groupe).
            expression.value = {
                kind: "not",
                child: { kind: "and", children: [] },
            };
        },
    },
];
function openRootMenu(e: Event) {
    rootMenu.value?.toggle(e);
}

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
        // david `5g7ngx` : start with an empty root so the user picks the
        // first block themselves (Condition / AND / OR / NOT).
        expression.value = null;
        actions.value = [{ kind: "assign", consumer_id: "" }];
        note.value = "";
    }
    validationError.value = null;
}

watch(() => props.rule?.id, () => loadFromProp(), { immediate: true });

// #504 — sources d'autocomplete (projects/agents/tags/consumers), fetchées une
// fois au mount et partagées à toute la sous-arbre via provide(). Les leaves
// font `inject(LEAF_SOURCES_KEY)` au lieu de re-fetch chacun.
const leafSources = createLeafSources();
provide(LEAF_SOURCES_KEY, leafSources);
onMounted(() => { void leafSources.refresh(); });

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
        // david `5g7ngx` : a null root means "the user didn't pick a starting
        // block" → save as the vacuous-true AND. The backend treats both
        // identically, so we don't surprise anyone with a "null was not
        // accepted" round-trip.
        expression: expression.value ?? { kind: "and", children: [] },
        actions: actions.value,
        note: note.value.trim() === "" ? null : note.value,
    });
}
</script>

<template>
    <div class="rule-editor">
        <!-- #457 david `5muwmt` : 2 tabulations builder + code. Form actions
             (cancel / save) restent en dehors des tabs : ils s'appliquent au
             draft courant, quelle que soit la vue. -->
        <Tabs v-model:value="activeView">
            <TabList>
                <Tab value="builder">
                    <i class="pi pi-th-large" /> Builder
                </Tab>
                <Tab value="code">
                    <i class="pi pi-code" /> Code
                </Tab>
            </TabList>
            <TabPanels>
                <TabPanel value="builder">
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
                            Compose with <strong>AND / OR / NOT</strong> groups, or use a
                            single condition. An empty root means the rule matches everything.
                        </p>
                        <!-- david `5g7ngx` : root commence vide, l'utilisateur
                             pick le premier block lui-même. Permet de démarrer
                             par NOT ou par un leaf seul, pas juste AND. -->
                        <div v-if="expression === null" class="rule-editor__empty-root">
                            <Button
                                icon="pi pi-plus"
                                label="Pick first condition…"
                                outlined
                                size="small"
                                @click="openRootMenu"
                            />
                            <Menu ref="rootMenu" :model="rootMenuItems" :popup="true" />
                            <span class="rule-editor__empty-hint">
                                (or save as-is — empty matches everything)
                            </span>
                        </div>
                        <ConditionNode
                            v-else
                            :node="expression"
                            @update="(n) => expression = n"
                            @remove="expression = null"
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
                </TabPanel>

                <TabPanel value="code">
                    <section class="aiball-section">
                        <h3>Equivalent YAML</h3>
                        <p class="aiball-explainer aiball-explainer--muted">
                            Canonical representation of the current draft as a YAML
                            <code>automation:</code> entry — paste as-is into a
                            <code>.aiball.yaml</code> (global or per-project).
                            Read-only for now — to edit, switch back to <strong>Builder</strong>
                            (a future slice can add an "Apply YAML" button that parses and
                            validates this textarea back into the form).
                        </p>
                        <pre class="rule-editor__code">{{ codeSnapshot }}</pre>
                    </section>
                </TabPanel>
            </TabPanels>
        </Tabs>

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
.rule-editor__code {
    background: var(--p-surface-100);
    padding: 0.8rem 1rem;
    border-radius: var(--radius-md);
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: var(--fs-md);
    line-height: 1.45;
    white-space: pre;
    margin: 0;
}
.rule-editor__empty-root {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem 0.8rem;
    border: 1px dashed var(--p-content-border-color);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--p-content-border-color) 8%, transparent);
}
.rule-editor__empty-hint {
    color: var(--p-text-muted-color);
    font-size: var(--fs-sm);
    font-style: italic;
}
</style>
