<script setup lang="ts">
/**
 * #457 — "Automation" : seule page d'automation du workflow.
 *
 * Slice 5.3a — quand `editRuleId` est set (URL = `/automation/rules/<id>` ou
 * `/new`), on affiche la rule detail page À LA PLACE de la liste. La nav
 * `Automation → <id>` se fait via DetailHeader (composant générique aiball
 * détail) qui émet `close` pour revenir à la liste.
 *
 * #506 — les anciens panels `<RulesPanel>` (moderation legacy) + `<WorkFiltersPanel>`
 * (work filters legacy) ont été retirés une fois que #483 a re-wiré les deux
 * call-sites sur `automation_rules` via le moteur unifié : leurs UIs éditaient
 * des rows qui ne sont plus consultées par le moteur — affichage trompeur.
 * Le backend (CLI `aiball rules ls`, API `/api/rules`, `/api/work-filters`)
 * reste en place pour l'instant ; suppression DB + code legacy = #465 reopen.
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
        <AutomationRuleDetailPage
            v-if="editRuleId !== null"
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
