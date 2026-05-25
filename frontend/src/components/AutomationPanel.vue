<script setup lang="ts">
/**
 * #457 — "Automation" : regroupe sous une seule page les deux automatisations
 * du workflow — les règles de modération (verdict sur un message posté) et les
 * work filters (gate de pickup par agent). Merge UI : les deux moteurs/API
 * restent séparés (ils agissent à des moments différents — POST vs ENGAGE),
 * ils sont juste présentés ensemble sous l'ombrelle « Automation ».
 */
import PanelHeader from "./ui/PanelHeader.vue";
import RulesPanel from "./RulesPanel.vue";
import WorkFiltersPanel from "./WorkFiltersPanel.vue";
</script>

<template>
    <div class="aiball-panel">
        <PanelHeader title="Automation">
            <p class="aiball-explainer aiball-explainer--muted">
                Two complementary workflow automations. <strong>Moderation rules</strong>
                decide what happens to a posted message (auto-approve / send to review);
                <strong>work filters</strong> narrow which tickets an agent picks up (by
                tag). Both are ordered, first-match config lists.
            </p>
        </PanelHeader>
        <RulesPanel />
        <WorkFiltersPanel />
    </div>
</template>
