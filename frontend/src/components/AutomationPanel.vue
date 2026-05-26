<script setup lang="ts">
/**
 * #457 — "Automation" : regroupe sous une seule page tous les moteurs
 * d'automation du workflow.
 *
 * Slice 5.3a — quand `editRuleId` est set (URL = `/automation/rules/<id>`
 * ou `/new`), on affiche la rule detail page À LA PLACE de la liste +
 * sections legacy. La nav `Automation → <id>` se fait via DetailHeader
 * (composant générique aiball détail) qui émet `close` pour revenir à
 * la liste.
 *
 * Sections legacy `<RulesPanel>` + `<WorkFiltersPanel>` restent en bas
 * du panel d'accueil tant que slice 6 (migration legacy → unified) ne
 * les retire pas (cf. ticket #465).
 */
import PanelHeader from "./ui/PanelHeader.vue";
import AutomationRulesSection from "./AutomationRulesSection.vue";
import AutomationRuleDetailPage from "./AutomationRuleDetailPage.vue";
import RulesPanel from "./RulesPanel.vue";
import WorkFiltersPanel from "./WorkFiltersPanel.vue";

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
                    Three automation surfaces. <strong>Automation rules</strong> is the
                    unified event-driven engine (assign on tag, etc.).
                    <strong>Moderation rules</strong> + <strong>work filters</strong> are
                    legacy ordered-config lists that will migrate into the unified engine
                    in a follow-up slice.
                </p>
            </PanelHeader>
            <AutomationRulesSection @open-edit="(id: string) => emit('open-edit', id)" />
            <RulesPanel />
            <WorkFiltersPanel />
        </template>
    </div>
</template>
