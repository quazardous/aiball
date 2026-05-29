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
import DataList, { type DataListColumn } from "./ui/DataList.vue";
import PanelHeader from "./ui/PanelHeader.vue";

// #614 david `79nsue` — migrate rule-list to DataList columns-mode. All
// columns are NON-sortable on purpose : the rules are evaluated in the
// order shown (first-match-wins), exposing a sort UI would lie about the
// runtime behavior. The mobile sort chooser auto-hides for the same
// reason (no sortable columns = nothing to show).
const columns: DataListColumn[] = [
    { key: "rank", label: "#", cellClass: "rule-col-rank" },
    { key: "label", label: "Rule", cellClass: "rule-col-label" },
    { key: "triggers", label: "On", cellClass: "rule-col-triggers" },
    { key: "action", label: "Action", cellClass: "rule-col-action" },
    { key: "enabled", label: "Enabled", cellClass: "rule-col-enabled" },
];

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

function ruleRowClass(r: AutomationRule): unknown {
    return {
        "rule-row": true,
        "rule-row--disabled": !r.enabled,
        "rule-row--yaml": r.id < 0,
        "dl-clickable": true,
    };
}

useBus("automation.refresh", () => load());
onMounted(load);
</script>

<template>
    <div class="aiball-panel">
        <PanelHeader :title="`Automation rules (${sortedRules.length})`">
            <template #actions>
                <Button
                    label="new rule"
                    icon="pi pi-plus"
                    size="small"
                    @click="emit('open-edit', 'new')"
                />
            </template>
            <p class="aiball-explainer aiball-explainer--muted">
                Unified <em>trigger → conditions → action</em> rules. First-match-wins
                — evaluated in the order shown. <strong>DB</strong> rules first
                (operator-controlled, top), then <strong>YAML</strong> rules
                (versioned defaults, bordered blue). Click a row to open its
                detail.
            </p>
        </PanelHeader>

        <DataList
                table-class="rules-table"
                :columns="columns"
                :rows="sortedRules"
                :row-key="(r) => r.id"
                :row-class="ruleRowClass"
                :is-empty="sortedRules.length === 0"
                @row-click="(r: AutomationRule) => emit('open-edit', String(r.id))"
            >
                <template #empty>
                    <div class="aiball-empty">
                        No automation rules yet. <a href="#" @click.prevent="emit('open-edit', 'new')">Create your first rule.</a>
                    </div>
                </template>

                <template #cell-rank="{ row }">
                    <span class="rule-rank-pill">{{ sortedRules.indexOf(row as AutomationRule) + 1 }}</span>
                </template>

                <template #cell-label="{ row }">
                    <span v-if="(row as AutomationRule).id < 0" class="source-badge" title="defined in .aiball.yaml — read-only">
                        <i class="pi pi-file" /> yaml
                    </span>
                    <span class="rule-label__text">{{ ruleLabel(row as AutomationRule) }}</span>
                </template>

                <template #cell-triggers="{ row }">
                    <span class="rule-triggers">{{ (row as AutomationRule).triggers.join(", ") || "(no triggers)" }}</span>
                </template>

                <template #cell-action="{ row }">
                    <span class="rule-action">{{ (row as AutomationRule).actions.map(formatActionCompact).join(" + ") }}</span>
                </template>

                <template #cell-enabled="{ row }">
                    <template v-if="(row as AutomationRule).id < 0">
                        <span class="yaml-readonly">read-only</span>
                    </template>
                    <template v-else>
                        <ToggleSwitch
                            :model-value="!!(row as AutomationRule).enabled"
                            @update:model-value="(v) => toggle(row as AutomationRule, !!v)"
                            @click.stop
                        />
                    </template>
                </template>
            </DataList>

        <div v-if="error" class="aiball-form-error">
            <i class="pi pi-exclamation-triangle" /> {{ error }}
        </div>
    </div>
</template>

<style scoped>
.rule-rank-pill {
    display: inline-flex;
    width: 1.6rem;
    height: 1.6rem;
    border-radius: 50%;
    background: var(--p-surface-100);
    color: var(--p-text-color);
    font-weight: 600;
    align-items: center;
    justify-content: center;
    font-size: 0.8rem;
}
.rule-label__text {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-weight: 500;
    font-size: 0.92rem;
}
.rule-triggers {
    font-family: ui-monospace, monospace;
    font-size: 0.82rem;
    color: var(--p-text-muted-color);
}
.rule-action {
    font-family: ui-monospace, monospace;
    font-size: 0.82rem;
    color: var(--p-purple-600);
}
.source-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    background: color-mix(in srgb, var(--p-blue-500) 15%, transparent);
    color: var(--p-blue-600);
    padding: 0.05rem 0.4rem;
    border-radius: 0.25rem;
    font-size: 0.72rem;
    font-family: ui-monospace, monospace;
    margin-right: 0.4rem;
}
.yaml-readonly {
    font-size: 0.75rem;
    font-style: italic;
    color: var(--p-text-muted-color);
}
/* YAML rules get a discreet left accent + tinted bg, same intent as
   the old `.rule-item--yaml` border-left. Applied via rowClass. */
:deep(.rules-table tr.rule-row--yaml td:first-child) {
    border-left: 3px solid var(--p-blue-500);
}
:deep(.rules-table tr.rule-row--yaml) {
    background: color-mix(in srgb, var(--p-blue-500) 4%, transparent);
}
:deep(.rules-table tr.rule-row--yaml:hover) {
    background: color-mix(in srgb, var(--p-blue-500) 8%, transparent);
}
:deep(.rules-table tr.rule-row--disabled) {
    opacity: 0.55;
}
/* Narrow viewports — mobile card pattern (Projects/Nodes-style). The
   data-label injected by DataList prefixes each cell so the values stay
   self-describing without a thead. Rank stays alone on its own line. */
@media (max-width: 720px) {
    :deep(.rules-table thead) {
        display: none;
    }
    :deep(.rules-table),
    :deep(.rules-table tbody),
    :deep(.rules-table tr) {
        display: block;
        width: 100%;
    }
    :deep(.rules-table tr) {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.25rem 0.7rem;
        border: none;
        border-bottom: 1px solid var(--p-content-border-color);
        padding: 0.5rem 0.7rem;
    }
    :deep(.rules-table td) {
        flex: 0 0 auto;
        padding: 0;
        border: none;
        text-align: left !important;
        width: auto !important;
        min-height: 0;
        display: inline-flex;
        align-items: baseline;
    }
    :deep(.rules-table td:not(.rule-col-rank):not(.rule-col-label)[data-label]::before) {
        content: attr(data-label) ": ";
        color: var(--p-text-muted-color);
        font-size: 0.78rem;
        margin-right: 0.3rem;
    }
    :deep(.rules-table tr.rule-row--yaml td:first-child) {
        border-left: none;
    }
    :deep(.rules-table tr.rule-row--yaml) {
        border-left: 3px solid var(--p-blue-500);
    }
}
</style>
