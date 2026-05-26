<script setup lang="ts">
/**
 * #457 slice 4 — UI CRUD pour la table `automation_rules` unifiée.
 *
 * Coexiste en section sœur de RulesPanel + WorkFiltersPanel dans
 * AutomationPanel.vue : les 3 sections vivent sur la même page « Automation »
 * en attendant que slice 3+ migre rules + work_filters dans cette table.
 *
 * Le formulaire couvre les 3 actions principales (assign, decision, pickup) +
 * `add_tag` / `set_priority` / `notify` côté schéma. Les conditions
 * disponibles s'adaptent au trigger sélectionné (ex : `kind` n'a de sens que
 * pour `message_posted`, `tag_added` pour `ticket_tagged`).
 */
import { computed, onMounted, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import MultiSelect from "primevue/multiselect";
import ToggleSwitch from "primevue/toggleswitch";
import {
    api,
    type AutomationRule,
    type AutomationAction,
    type AutomationTrigger,
} from "../lib/api";
import { bus, useBus } from "../lib/bus";

const rules = ref<AutomationRule[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);

// Form state.
const triggers = ref<AutomationTrigger[]>(["ticket_created", "ticket_tagged"]);
const actionKind = ref<AutomationAction["kind"]>("assign");
const actionConsumerId = ref("");
const actionDecision = ref<"auto" | "review">("auto");
const actionPickupMode = ref<"only" | "except">("only");
const actionAddTag = ref("");
const actionPriority = ref<"urgent" | "high" | "normal" | "low">("normal");
const matchProject = ref("");
const matchKind = ref<string | null>(null);
const matchBy = ref("");
const matchTags = ref(""); // comma-separated input
const matchTagAdded = ref("");
const matchIntent = ref<string | null>(null);
const matchPriority = ref<string | null>(null);
const scopeConsumer = ref("");
const note = ref("");

const triggerOptions = [
    { label: "ticket created", value: "ticket_created" as const },
    { label: "ticket tagged", value: "ticket_tagged" as const },
    { label: "message posted", value: "message_posted" as const },
    { label: "actionable eval", value: "actionable_eval" as const },
];

const actionKindOptions = [
    { label: "assign to agent", value: "assign" as const },
    { label: "moderation decision", value: "decision" as const },
    { label: "pickup gate", value: "pickup" as const },
    { label: "add tag", value: "add_tag" as const },
    { label: "set priority", value: "set_priority" as const },
    { label: "notify", value: "notify" as const },
];

const kindOptions = [
    { label: "(any)", value: null },
    { label: "ticket_created", value: "ticket_created" },
    { label: "comment_added", value: "comment_added" },
    { label: "ticket_closed", value: "ticket_closed" },
];

const intentOptions = [
    { label: "(any)", value: null },
    { label: "panic", value: "panic" },
    { label: "request", value: "request" },
    { label: "question", value: "question" },
    { label: "fyi", value: "fyi" },
];

const priorityOptions = [
    { label: "(any)", value: null },
    { label: "urgent", value: "urgent" },
    { label: "high", value: "high" },
    { label: "normal", value: "normal" },
    { label: "low", value: "low" },
];

const decisionOptions = [
    { label: "auto-approve", value: "auto" as const },
    { label: "send to review", value: "review" as const },
];

const pickupModeOptions = [
    { label: "only (include)", value: "only" as const },
    { label: "except (exclude)", value: "except" as const },
];

const setPriorityOptions = [
    { label: "urgent", value: "urgent" as const },
    { label: "high", value: "high" as const },
    { label: "normal", value: "normal" as const },
    { label: "low", value: "low" as const },
];

const sortedRules = computed(() =>
    [...rules.value].sort((a, b) => a.position - b.position || a.id - b.id),
);

const showsKind = computed(() => triggers.value.includes("message_posted"));
const showsTagAdded = computed(() => triggers.value.includes("ticket_tagged"));
const showsScopeConsumer = computed(() => triggers.value.includes("actionable_eval"));

async function load() {
    try {
        rules.value = await api.listAutomationRules();
        error.value = null;
    } catch (e) {
        error.value = (e as Error).message;
    }
}

function buildAction(): AutomationAction | { error: string } {
    switch (actionKind.value) {
        case "assign":
            if (!actionConsumerId.value.trim()) return { error: "consumer_id required for assign" };
            return { kind: "assign", consumer_id: actionConsumerId.value.trim() };
        case "decision":
            return { kind: "decision", decision: actionDecision.value };
        case "pickup":
            return { kind: "pickup", mode: actionPickupMode.value };
        case "add_tag":
            if (!actionAddTag.value.trim()) return { error: "tag required for add_tag" };
            return { kind: "add_tag", tag: actionAddTag.value.trim() };
        case "set_priority":
            return { kind: "set_priority", priority: actionPriority.value };
        case "notify":
            if (!actionConsumerId.value.trim()) return { error: "consumer_id required for notify" };
            return { kind: "notify", consumer_id: actionConsumerId.value.trim() };
    }
}

async function add() {
    if (triggers.value.length === 0) {
        error.value = "pick at least one trigger";
        return;
    }
    const action = buildAction();
    if ("error" in action) {
        error.value = action.error;
        return;
    }
    const tags = matchTags.value.split(",").map((t) => t.trim()).filter(Boolean);
    busy.value = true;
    try {
        await api.addAutomationRule({
            triggers: triggers.value,
            scope_consumer: showsScopeConsumer.value && scopeConsumer.value.trim()
                ? scopeConsumer.value.trim()
                : null,
            match_project: matchProject.value.trim() || null,
            match_kind: showsKind.value ? matchKind.value : null,
            match_by_agent: matchBy.value.trim() || null,
            match_tags: tags,
            match_tag_added: showsTagAdded.value && matchTagAdded.value.trim()
                ? matchTagAdded.value.trim()
                : null,
            match_intent: matchIntent.value,
            match_priority: matchPriority.value,
            action,
            note: note.value.trim() || null,
        });
        // Reset the inputs that vary per-rule (keep trigger/action selectors).
        matchProject.value = "";
        matchKind.value = null;
        matchBy.value = "";
        matchTags.value = "";
        matchTagAdded.value = "";
        matchIntent.value = null;
        matchPriority.value = null;
        scopeConsumer.value = "";
        actionConsumerId.value = "";
        actionAddTag.value = "";
        note.value = "";
        error.value = null;
        bus.emit("automation.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        busy.value = false;
    }
}

async function toggle(r: AutomationRule, enabled: boolean) {
    try {
        await api.toggleAutomationRule(r.id, enabled);
        bus.emit("automation.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    }
}

async function del(r: AutomationRule) {
    if (!confirm(`Delete automation rule #${r.id}?`)) return;
    try {
        await api.delAutomationRule(r.id);
        bus.emit("automation.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    }
}

function ruleConds(r: AutomationRule): { label: string; value: string }[] {
    const c: { label: string; value: string }[] = [];
    if (r.match_project) c.push({ label: "project", value: r.match_project });
    if (r.match_kind) c.push({ label: "kind", value: r.match_kind });
    if (r.match_by_agent) c.push({ label: "by", value: r.match_by_agent });
    if (r.match_tags.length) c.push({ label: "tags", value: r.match_tags.join(",") });
    if (r.match_tag_added) c.push({ label: "tag_added", value: r.match_tag_added });
    if (r.match_intent) c.push({ label: "intent", value: r.match_intent });
    if (r.match_priority) c.push({ label: "priority", value: r.match_priority });
    if (r.scope_consumer) c.push({ label: "scope", value: r.scope_consumer });
    return c;
}

function ruleVerb(r: AutomationRule): string {
    switch (r.action.kind) {
        case "assign": return `assign to ${r.action.consumer_id}`;
        case "decision": return r.action.decision === "auto" ? "auto-approve" : "send to review";
        case "pickup": return r.action.mode === "only" ? "include in pickup" : "exclude from pickup";
        case "add_tag": return `add tag ${r.action.tag}`;
        case "set_priority": return `set priority ${r.action.priority}`;
        case "notify": return `notify ${r.action.consumer_id}`;
    }
}

useBus("automation.refresh", () => load());
onMounted(load);
</script>

<template>
    <div class="aiball-panel">
        <section class="aiball-section">
            <div class="aiball-section__head">
                <h3>Automation rules ({{ sortedRules.length }})</h3>
            </div>
            <p class="aiball-explainer">
                Unified <em>trigger → conditions → action</em> rules. First-match-wins
                (caller-ordered by position, then id). A rule's <strong>triggers</strong> is a union —
                one rule can fire on multiple lifecycle events.
            </p>

            <div v-if="!sortedRules.length" class="aiball-empty">
                No automation rules yet.
            </div>

            <ol class="rule-list">
                <li
                    v-for="(r, i) in sortedRules"
                    :key="r.id"
                    class="rule-item"
                    :class="{ disabled: !r.enabled }"
                >
                    <div class="rule-rank">{{ i + 1 }}</div>
                    <div class="rule-body">
                        <div class="rule-sentence">
                            <span class="kw">on</span>
                            <span
                                v-for="t in r.triggers"
                                :key="t"
                                class="trigger-chip"
                            >{{ t }}</span>
                            <template v-if="ruleConds(r).length">
                                <span class="kw">if</span>
                                <template
                                    v-for="(c, idx) in ruleConds(r)"
                                    :key="c.label"
                                >
                                    <span v-if="idx > 0" class="kw kw-and">and</span>
                                    <span class="cond">
                                        <span class="cond-label">{{ c.label }}</span>
                                        <span class="cond-eq">=</span>
                                        <span class="cond-value">{{ c.value }}</span>
                                    </span>
                                </template>
                            </template>
                            <span class="kw">→</span>
                            <span class="verdict" :class="`verdict-${r.action.kind}`">
                                {{ ruleVerb(r) }}
                            </span>
                        </div>
                        <div v-if="r.note" class="rule-note">
                            <i class="pi pi-info-circle" />
                            <em>{{ r.note }}</em>
                        </div>
                        <div class="rule-id">rule #{{ r.id }}</div>
                    </div>
                    <div class="rule-controls">
                        <ToggleSwitch
                            :model-value="!!r.enabled"
                            @update:model-value="(v) => toggle(r, !!v)"
                        />
                        <Button
                            icon="pi pi-trash"
                            severity="danger"
                            text
                            rounded
                            size="small"
                            @click="del(r)"
                        />
                    </div>
                </li>
            </ol>
        </section>

        <section class="aiball-section">
            <h3>Add a rule</h3>
            <p class="aiball-explainer aiball-explainer--muted">
                Build a sentence: <em>on</em> &lt;triggers&gt; <em>if</em> &lt;conditions&gt; <em>then</em> &lt;action&gt;.
            </p>
            <div class="aiball-form-grid">
                <span class="kw">on</span>
                <div class="aiball-field" style="grid-column: span 5">
                    <label class="field-label">triggers (union — fires on any of)</label>
                    <MultiSelect
                        v-model="triggers"
                        :options="triggerOptions"
                        option-label="label"
                        option-value="value"
                        placeholder="pick one or more"
                        class="w-full"
                    />
                </div>
            </div>
            <div class="aiball-form-grid">
                <span class="kw">if</span>
                <div class="aiball-field">
                    <label class="field-label">project</label>
                    <InputText v-model="matchProject" placeholder="(any)" class="w-full" />
                </div>
                <span class="kw kw-and">and</span>
                <div class="aiball-field">
                    <label class="field-label">tags (any-of, comma-separated)</label>
                    <InputText v-model="matchTags" placeholder="(any)" class="w-full" />
                </div>
                <span class="kw kw-and">and</span>
                <div class="aiball-field">
                    <label class="field-label">by_agent</label>
                    <InputText v-model="matchBy" placeholder="(any)" class="w-full" />
                </div>
            </div>
            <div class="aiball-form-grid">
                <span class="kw kw-and">and</span>
                <div class="aiball-field">
                    <label class="field-label">intent</label>
                    <Select
                        v-model="matchIntent"
                        :options="intentOptions"
                        option-label="label"
                        option-value="value"
                        class="w-full"
                    />
                </div>
                <span class="kw kw-and">and</span>
                <div class="aiball-field">
                    <label class="field-label">priority</label>
                    <Select
                        v-model="matchPriority"
                        :options="priorityOptions"
                        option-label="label"
                        option-value="value"
                        class="w-full"
                    />
                </div>
                <template v-if="showsKind">
                    <span class="kw kw-and">and</span>
                    <div class="aiball-field">
                        <label class="field-label">message kind</label>
                        <Select
                            v-model="matchKind"
                            :options="kindOptions"
                            option-label="label"
                            option-value="value"
                            class="w-full"
                        />
                    </div>
                </template>
            </div>
            <div v-if="showsTagAdded || showsScopeConsumer" class="aiball-form-grid">
                <template v-if="showsTagAdded">
                    <span class="kw kw-and">and</span>
                    <div class="aiball-field">
                        <label class="field-label">tag added (ticket_tagged only)</label>
                        <InputText
                            v-model="matchTagAdded"
                            placeholder="(any tag-add fires)"
                            class="w-full"
                        />
                    </div>
                </template>
                <template v-if="showsScopeConsumer">
                    <span class="kw kw-and">and</span>
                    <div class="aiball-field">
                        <label class="field-label">scope_consumer (actionable_eval only)</label>
                        <InputText
                            v-model="scopeConsumer"
                            placeholder="(global)"
                            class="w-full"
                        />
                    </div>
                </template>
            </div>
            <div class="aiball-form-grid">
                <span class="kw">→</span>
                <div class="aiball-field">
                    <label class="field-label">action</label>
                    <Select
                        v-model="actionKind"
                        :options="actionKindOptions"
                        option-label="label"
                        option-value="value"
                        class="w-full"
                    />
                </div>
                <template v-if="actionKind === 'assign' || actionKind === 'notify'">
                    <span class="kw kw-and">to</span>
                    <div class="aiball-field">
                        <label class="field-label">consumer_id</label>
                        <InputText
                            v-model="actionConsumerId"
                            placeholder="e.g. aiball-windows"
                            class="w-full"
                        />
                    </div>
                </template>
                <template v-else-if="actionKind === 'decision'">
                    <span class="kw kw-and">with</span>
                    <div class="aiball-field">
                        <label class="field-label">decision</label>
                        <Select
                            v-model="actionDecision"
                            :options="decisionOptions"
                            option-label="label"
                            option-value="value"
                            class="w-full"
                        />
                    </div>
                </template>
                <template v-else-if="actionKind === 'pickup'">
                    <span class="kw kw-and">mode</span>
                    <div class="aiball-field">
                        <label class="field-label">pickup mode</label>
                        <Select
                            v-model="actionPickupMode"
                            :options="pickupModeOptions"
                            option-label="label"
                            option-value="value"
                            class="w-full"
                        />
                    </div>
                </template>
                <template v-else-if="actionKind === 'add_tag'">
                    <span class="kw kw-and">tag</span>
                    <div class="aiball-field">
                        <label class="field-label">tag name</label>
                        <InputText v-model="actionAddTag" placeholder="e.g. needs-triage" class="w-full" />
                    </div>
                </template>
                <template v-else-if="actionKind === 'set_priority'">
                    <span class="kw kw-and">to</span>
                    <div class="aiball-field">
                        <label class="field-label">priority</label>
                        <Select
                            v-model="actionPriority"
                            :options="setPriorityOptions"
                            option-label="label"
                            option-value="value"
                            class="w-full"
                        />
                    </div>
                </template>
            </div>
            <div class="aiball-form-row">
                <div class="aiball-field" style="flex: 1">
                    <label class="field-label">note (optional)</label>
                    <InputText
                        v-model="note"
                        placeholder="why this rule exists"
                        class="w-full"
                    />
                </div>
                <Button
                    label="add rule"
                    icon="pi pi-plus"
                    :loading="busy"
                    @click="add"
                />
            </div>
        </section>

        <div v-if="error" class="aiball-form-error">
            <i class="pi pi-exclamation-triangle" /> {{ error }}
        </div>
    </div>
</template>

<style scoped>
.rule-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}
.rule-item {
    display: grid;
    grid-template-columns: 2rem 1fr auto;
    gap: 0.7rem;
    align-items: start;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.4rem;
}
.rule-item.disabled {
    opacity: 0.5;
    background: var(--p-surface-50);
}
.rule-rank {
    width: 1.8rem;
    height: 1.8rem;
    border-radius: 50%;
    background: var(--p-surface-100);
    color: var(--p-text-color);
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.85rem;
}
.rule-body {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
}
.rule-sentence {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
    line-height: 1.6;
}
.kw {
    color: var(--p-text-muted-color);
    font-style: italic;
    font-size: 0.85rem;
}
.kw-and {
    color: var(--p-text-muted-color);
    text-transform: lowercase;
}
.cond {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: var(--p-surface-100);
    padding: 0.1rem 0.5rem;
    border-radius: 0.3rem;
    font-size: 0.9rem;
}
.cond-label {
    color: var(--p-text-muted-color);
    font-size: 0.85rem;
}
.cond-eq {
    color: var(--p-text-muted-color);
}
.cond-value {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-weight: 500;
}
.trigger-chip {
    background: color-mix(in srgb, var(--p-blue-500) 15%, transparent);
    color: var(--p-blue-600);
    padding: 0.15rem 0.55rem;
    border-radius: 0.3rem;
    font-size: 0.85rem;
    font-family: ui-monospace, monospace;
}
.verdict {
    padding: 0.15rem 0.55rem;
    border-radius: 0.3rem;
    font-weight: 600;
    font-size: 0.9rem;
}
.verdict-assign {
    background: color-mix(in srgb, var(--p-purple-500) 15%, transparent);
    color: var(--p-purple-600);
}
.verdict-decision {
    background: color-mix(in srgb, var(--p-green-500) 15%, transparent);
    color: var(--p-green-600);
}
.verdict-pickup {
    background: color-mix(in srgb, var(--p-cyan-500) 15%, transparent);
    color: var(--p-cyan-600);
}
.verdict-add_tag,
.verdict-set_priority,
.verdict-notify {
    background: color-mix(in srgb, var(--p-orange-500) 15%, transparent);
    color: var(--p-orange-600);
}
.rule-note {
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
}
.rule-id {
    font-size: 0.75rem;
    color: var(--p-text-muted-color);
    font-family: ui-monospace, monospace;
}
.rule-controls {
    display: flex;
    align-items: center;
    gap: 0.4rem;
}
</style>
