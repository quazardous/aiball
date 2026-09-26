<script setup lang="ts">
/**
 * #457 — "Automation": the workflow's one automation page.
 *
 * Slice 5.3a — when `editRuleId` is set (URL `/automation/rules/<id>` or
 * `/new`), the rule detail page shows INSTEAD of the list. Navigating
 * `Automation → <id>` goes through DetailHeader (the generic aiball detail
 * component), which emits `close` to return to the list.
 *
 * #506 — the old `<RulesPanel>` (legacy moderation) and `<WorkFiltersPanel>`
 * (legacy work filters) were removed once #483 rewired both call sites onto
 * `automation_rules` through the unified engine: their UIs edited rows the
 * engine no longer read, a misleading display. Both legacy backends are gone
 * too — `/api/rules` and `/api/work-filters`, and their tables (migrations
 * 0074 and 0075) —
 * and `aiball rule` now writes automation rules.
 */
import PanelHeader from "./ui/PanelHeader.vue";
import AutomationRulesSection from "./AutomationRulesSection.vue";
import AutomationRuleDetailPage from "./AutomationRuleDetailPage.vue";

defineProps<{ editRuleId: string | null }>();
const emit = defineEmits<{
    (e: "open-edit", id: string): void;
    (e: "close-edit"): void;
}>();
</script>

<template>
    <div class="aiball-panel">
        <!-- #521 : `:key` force un remount complet quand `editRuleId` change
             (ex. "42" → "new", ou save+close+reopen "new"). Sans ça, Vue
             réutilise la même instance et l'état interne de RuleEditor
             (refs triggers/expression/actions/note) persistait — d'où la
             rule précédente qui s'affichait en réouvrant "new". -->
        <AutomationRuleDetailPage
            v-if="editRuleId !== null"
            :key="editRuleId"
            :rule-id="editRuleId"
            @close="emit('close-edit')"
        />
        <template v-else>
            <PanelHeader title="Automation">
                <p class="aiball-explainer aiball-explainer--muted">
                    Event-driven rules (assign on tag, moderation decisions, work-filter
                    pickups). All routed through the unified engine.
                </p>
            </PanelHeader>
            <AutomationRulesSection @open-edit="(id: string) => emit('open-edit', id)" />
        </template>
    </div>
</template>
