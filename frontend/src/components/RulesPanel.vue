<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import ToggleSwitch from "primevue/toggleswitch";
import { api, type Rule } from "../lib/api";
import { bus, useBus } from "../lib/bus";

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
    { label: "(any kind)", value: null },
    { label: "ticket_created", value: "ticket_created" },
    { label: "comment_added", value: "comment_added" },
    { label: "ticket_closed", value: "ticket_closed" },
];

const sortedRules = computed(() =>
    [...rules.value].sort((a, b) => a.position - b.position || a.id - b.id),
);

async function load() {
    try {
        rules.value = await api.listRules();
        error.value = null;
    } catch (e) {
        error.value = (e as Error).message;
    }
}

function ruleSentence(r: Rule): { conds: { label: string; value: string }[]; verdict: string } {
    const conds: { label: string; value: string }[] = [];
    if (r.match_project) conds.push({ label: "project", value: r.match_project });
    if (r.match_kind) conds.push({ label: "kind", value: r.match_kind });
    if (r.match_by_agent) conds.push({ label: "by", value: r.match_by_agent });
    return {
        conds,
        verdict:
            r.decision === "auto" ? "auto-approve" : "send to human review",
    };
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
        bus.emit("rules.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        busy.value = false;
    }
}

async function toggle(r: Rule, enabled: boolean) {
    try {
        await api.toggleRule(r.id, enabled);
        bus.emit("rules.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    }
}

async function del(r: Rule) {
    if (!confirm(`Delete rule #${r.id}?`)) return;
    try {
        await api.delRule(r.id);
        bus.emit("rules.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    }
}

// Self-refresh on bus events — covers our own mutations (round-trips
// instantly) and any rule change made elsewhere (WS-driven).
useBus("rules.refresh", () => load());
onMounted(load);
</script>

<template>
    <div class="rules-page">
        <header class="rules-header">
            <h2>Moderation rules</h2>
            <p class="rules-explainer">
                Rules decide what happens to a posted message <em>before</em> it reaches subscribers.
                <strong>First match wins</strong>: the rules below are evaluated top to bottom and
                the first one that matches sets the outcome. If no rule matches, the message is
                <strong>sent to human review</strong> in the Pending tab.
            </p>
            <p class="rules-explainer rules-explainer--muted">
                Each condition is optional. A blank condition means <em>any value</em>. A rule with
                no conditions matches every message — useful as a catch-all at the bottom.
            </p>
        </header>

        <section class="rules-section">
            <div class="rules-section-head">
                <h3>Active rules ({{ sortedRules.length }})</h3>
            </div>

            <div v-if="!sortedRules.length" class="aiball-empty">
                No rules yet. Every message will go to manual review until you add one.
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
                            <span class="kw">if</span>
                            <template v-if="ruleSentence(r).conds.length === 0">
                                <span class="cond cond-any">message matches anything</span>
                            </template>
                            <template v-else>
                                <template
                                    v-for="(c, idx) in ruleSentence(r).conds"
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
                            <span
                                class="verdict"
                                :class="r.decision === 'auto' ? 'verdict-auto' : 'verdict-review'"
                            >
                                {{ ruleSentence(r).verdict }}
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

        <section class="rules-section">
            <h3>Add a rule</h3>
            <p class="rules-explainer rules-explainer--muted">
                Build a sentence: <em>if</em> these conditions match, <em>then</em> apply this verdict.
            </p>
            <div class="rule-builder">
                <span class="kw">if</span>
                <div class="builder-cond">
                    <label class="field-label">project</label>
                    <InputText v-model="matchProject" placeholder="(any)" class="w-full" />
                </div>
                <span class="kw kw-and">and</span>
                <div class="builder-cond">
                    <label class="field-label">kind</label>
                    <Select
                        v-model="matchKind"
                        :options="kindOptions"
                        option-label="label"
                        option-value="value"
                        class="w-full"
                    />
                </div>
                <span class="kw kw-and">and</span>
                <div class="builder-cond">
                    <label class="field-label">by_agent</label>
                    <InputText v-model="matchBy" placeholder="(any)" class="w-full" />
                </div>
                <span class="kw">→</span>
                <div class="builder-cond">
                    <label class="field-label">verdict</label>
                    <Select
                        v-model="decision"
                        :options="decisionOptions"
                        option-label="label"
                        option-value="value"
                        class="w-full"
                    />
                </div>
            </div>
            <div class="builder-row">
                <div class="builder-cond" style="flex: 1">
                    <label class="field-label">note (optional, shown in the rule list)</label>
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

        <div v-if="error" class="rules-error">
            <i class="pi pi-exclamation-triangle" /> {{ error }}
        </div>
    </div>
</template>

<style>
.rules-page {
    display: flex;
    flex-direction: column;
    gap: 1.4rem;
}
.rules-header h2 {
    margin: 0 0 0.4rem;
}
.rules-explainer {
    margin: 0.3rem 0;
    color: var(--p-text-color);
    line-height: 1.45;
}
.rules-explainer--muted {
    color: var(--p-text-muted-color);
    font-size: 0.9rem;
}
.rules-section {
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.5rem;
    padding: 1rem 1.2rem;
    background: var(--p-content-background);
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
}
.rules-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
}
.rules-section h3 {
    margin: 0;
    font-size: 1rem;
}
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
.cond-any {
    font-style: italic;
    color: var(--p-text-muted-color);
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
.verdict {
    padding: 0.15rem 0.55rem;
    border-radius: 0.3rem;
    font-weight: 600;
    font-size: 0.9rem;
}
.verdict-auto {
    background: color-mix(in srgb, var(--p-green-500) 15%, transparent);
    color: var(--p-green-600);
}
.verdict-review {
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

.rule-builder {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: end;
}
.builder-cond {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 9rem;
}
.builder-cond .field-label {
    margin-bottom: 0;
    font-size: 0.75rem;
}
.builder-row {
    display: flex;
    align-items: end;
    gap: 0.6rem;
    margin-top: 0.4rem;
}

.rules-error {
    color: var(--p-red-500);
    background: color-mix(in srgb, var(--p-red-500) 10%, transparent);
    padding: 0.6rem 0.8rem;
    border-radius: 0.4rem;
}
</style>
