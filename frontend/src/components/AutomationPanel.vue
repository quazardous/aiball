<script setup lang="ts">
/**
 * #457 — "Automation" : regroupe sous une seule page tous les moteurs
 * d'automation du workflow.
 *
 * Slice 4 ajoute la section unifiée `<AutomationRulesSection>` (CRUD direct
 * sur la table `automation_rules`, moteur événementiel = ticket_created /
 * ticket_tagged / message_posted / actionable_eval, actions = assign /
 * decision / pickup / add_tag / set_priority / notify). Les sections legacy
 * `<RulesPanel>` (moderation) et `<WorkFiltersPanel>` (pickup) restent
 * affichées en parallèle tant que slice 3+ ne migre pas leurs rows ici.
 */
import PanelHeader from "./ui/PanelHeader.vue";
import AutomationRulesSection from "./AutomationRulesSection.vue";
import RulesPanel from "./RulesPanel.vue";
import WorkFiltersPanel from "./WorkFiltersPanel.vue";
</script>

<template>
    <div class="aiball-panel">
        <PanelHeader title="Automation">
            <p class="aiball-explainer aiball-explainer--muted">
                Three automation surfaces. <strong>Automation rules</strong> is the
                unified event-driven engine (assign on tag, etc.).
                <strong>Moderation rules</strong> + <strong>work filters</strong> are
                legacy ordered-config lists that will migrate into the unified engine
                in a follow-up slice.
            </p>
        </PanelHeader>
        <AutomationRulesSection />
        <RulesPanel />
        <WorkFiltersPanel />
    </div>
</template>
