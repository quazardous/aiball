<script setup lang="ts">
/**
 * #457 slice 5.3a — flat-label list view for automation rules.
 *
 * David `yjp9hk` : "la modification creation de rule devrait etre dasn un
 * detail rule et la gestion de l'ordre dasn la liste (avec juste un label
 * descriptif custom, default sur une autogeneration)". So this section
 * stops being an inline form + chip-list, it becomes a clean LIST of
 * rules with their auto-generated (or custom) labels and a "+ new rule"
 * button that routes to the detail page (5.3b).
 *
 * The label is the rule's `note` if set, else an auto-generated compact
 * expression rendering (`formatExpressionCompact` from lib/format.ts).
 *
 * YAML rules (id < 0) keep their distinctive bordered look + read-only
 * controls, but click-through still opens the detail page in YAML mode
 * (you can read the rule but not save changes).
 */
import { computed, onMounted, ref } from "vue";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import {
    api,
    type AutomationRule,
} from "../lib/api";
import { bus, useBus } from "../lib/bus";
import { formatActionCompact, formatExpressionCompact } from "../lib/format";

const emit = defineEmits<{ (e: "open-edit", id: string): void }>();

const rules = ref<AutomationRule[]>([]);
const error = ref<string | null>(null);

const sortedRules = computed(() => {
    // Server returns DB rules (id > 0) first, YAML rules (id < 0) second.
    // Preserve that order so the list reads in evaluation order
    // (first-match-wins) ; DB block tiebreaks on (position asc, id asc).
    const db = rules.value.filter((r) => r.id > 0);
    const yaml = rules.value.filter((r) => r.id < 0);
    db.sort((a, b) => a.position - b.position || a.id - b.id);
    return [...db, ...yaml];
});

async function load() {
    try {
        rules.value = await api.listAutomationRules();
        error.value = null;
    } catch (e) {
        error.value = (e as Error).message;
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

/** The rule's display label : custom `note` wins, else the auto-rendered
 *  compact expression (mirrors what david asked for in `yjp9hk` — "label
 *  descriptif custom, default sur une autogeneration"). */
function ruleLabel(r: AutomationRule): string {
    if (r.note && r.note.trim()) return r.note;
    return formatExpressionCompact(r.expression);
}

useBus("automation.refresh", () => load());
onMounted(load);
</script>

<template>
    <div class="aiball-panel">
        <section class="aiball-section">
            <div class="aiball-section__head">
                <h3>Automation rules ({{ sortedRules.length }})</h3>
                <Button
                    label="new rule"
                    icon="pi pi-plus"
                    size="small"
                    @click="emit('open-edit', 'new')"
                />
            </div>
            <p class="aiball-explainer">
                Unified <em>trigger → conditions → action</em> rules. First-match-wins
                — evaluated in the order shown. <strong>DB</strong> rules first
                (operator-controlled, top), then <strong>YAML</strong> rules
                (versioned defaults, bordered blue). Click a row to open its
                detail.
            </p>

            <div v-if="!sortedRules.length" class="aiball-empty">
                No automation rules yet. <a href="#" @click.prevent="emit('open-edit', 'new')">Create your first rule.</a>
            </div>

            <ol class="rule-list">
                <li
                    v-for="(r, i) in sortedRules"
                    :key="r.id"
                    class="rule-item"
                    :class="{ disabled: !r.enabled, 'rule-item--yaml': r.id < 0 }"
                >
                    <div class="rule-rank">{{ i + 1 }}</div>
                    <button
                        class="rule-body"
                        type="button"
                        @click="emit('open-edit', String(r.id))"
                    >
                        <div class="rule-label">
                            <span v-if="r.id < 0" class="source-badge" title="defined in .aiball.yaml — read-only">
                                <i class="pi pi-file" /> yaml
                            </span>
                            <span class="rule-label__text">{{ ruleLabel(r) }}</span>
                        </div>
                        <div class="rule-meta">
                            <span class="rule-meta__triggers">on {{ r.triggers.join(", ") || "(no triggers)" }}</span>
                            <span class="rule-meta__sep">→</span>
                            <span class="rule-meta__action">{{ r.actions.map(formatActionCompact).join(" + ") }}</span>
                        </div>
                    </button>
                    <div class="rule-controls">
                        <template v-if="r.id < 0">
                            <!-- YAML rule : read-only, edit the file. -->
                            <span class="aiball-explainer aiball-explainer--muted yaml-readonly">
                                read-only
                            </span>
                        </template>
                        <template v-else>
                            <ToggleSwitch
                                :model-value="!!r.enabled"
                                @update:model-value="(v) => toggle(r, !!v)"
                                @click.stop
                            />
                        </template>
                    </div>
                </li>
            </ol>
        </section>

        <div v-if="error" class="aiball-form-error">
            <i class="pi pi-exclamation-triangle" /> {{ error }}
        </div>
    </div>
</template>

<style scoped>
.aiball-section__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
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
    align-items: stretch;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.4rem;
    background: var(--p-content-background, transparent);
    transition: background 0.1s;
}
.rule-item:hover {
    background: var(--p-surface-50);
}
.rule-item.disabled {
    opacity: 0.55;
    background: var(--p-surface-50);
}
.rule-item--yaml {
    border-left: 3px solid var(--p-blue-500);
    background: color-mix(in srgb, var(--p-blue-500) 4%, transparent);
}
.rule-item--yaml:hover {
    background: color-mix(in srgb, var(--p-blue-500) 8%, transparent);
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
    align-self: center;
}
.rule-body {
    /* The row's body is a button — full row of the label/meta area is
       clickable to open the rule detail page. Reset button-ish styles
       to keep the look identical to the previous non-clickable rendering. */
    all: unset;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    text-align: left;
    min-width: 0;
}
.rule-body:focus-visible {
    outline: 2px solid var(--p-primary-color);
    outline-offset: 2px;
    border-radius: 0.3rem;
}
.rule-label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-weight: 500;
    font-size: 0.95rem;
    line-height: 1.3;
}
.rule-label__text {
    overflow: hidden;
    text-overflow: ellipsis;
}
.rule-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: center;
    font-size: 0.8rem;
    color: var(--p-text-muted-color);
}
.rule-meta__triggers {
    font-family: ui-monospace, monospace;
}
.rule-meta__sep {
    opacity: 0.6;
}
.rule-meta__action {
    color: var(--p-purple-600);
    font-family: ui-monospace, monospace;
}
.rule-controls {
    display: flex;
    align-items: center;
    gap: 0.4rem;
}
.source-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    background: color-mix(in srgb, var(--p-blue-500) 15%, transparent);
    color: var(--p-blue-600);
    padding: 0.05rem 0.4rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
}
.yaml-readonly {
    font-size: 0.75rem;
    font-style: italic;
    align-self: center;
}
</style>
