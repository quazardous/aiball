<script setup lang="ts">
import { computed } from "vue";
import Button from "primevue/button";
import {
    BULK_ACTION_META,
    BULK_ACTIONS_IN_ORDER,
} from "../lib/labels";
import { type BulkAction } from "../lib/ticket-actions";

export type BulkCounts = Record<BulkAction, number>;

const props = defineProps<{
    selectedSize: number;
    counts: BulkCounts;
    busy: boolean;
}>();

const emit = defineEmits<{
    (e: "clear"): void;
    (e: "select-all"): void;
    (e: "action", action: BulkAction): void;
}>();

/**
 * Render order coming from the catalog. mark_read and mark_unread
 * collapse into a single button picking the larger of the two counts —
 * `unreadAction` is computed in templates, see below.
 */
const renderActions = computed<BulkAction[]>(() =>
    BULK_ACTIONS_IN_ORDER.filter((a) => a !== "mark_unread"),
);

/** The combined read/unread button picks whichever side has more rows. */
const readToggleAction = computed<BulkAction>(() =>
    props.counts.mark_read >= props.counts.mark_unread ? "mark_read" : "mark_unread",
);
</script>

<template>
    <div
        class="bulk-bar bulk-bar--bottom"
        :class="{ 'bulk-bar--has-selection': selectedSize > 0 }"
    >
        <Button
            :label="selectedSize ? 'clear' : 'select all'"
            :icon="selectedSize ? 'pi pi-minus' : 'pi pi-list'"
            size="small"
            severity="secondary"
            text
            @click="selectedSize ? emit('clear') : emit('select-all')"
        />
        <span class="bulk-count" v-if="selectedSize">
            <strong>{{ selectedSize }}</strong> selected
        </span>
        <span class="spacer" />
        <template v-for="action in renderActions" :key="action">
            <!--
                Read / unread is rendered as a single button: pick the
                side with more eligible rows. mark_unread is filtered
                out of renderActions; mark_read is the slot that
                renders the combined toggle.
            -->
            <Button
                v-if="action === 'mark_read'"
                v-show="counts.mark_read || counts.mark_unread"
                :icon="BULK_ACTION_META[readToggleAction].icon"
                :label="`${BULK_ACTION_META[readToggleAction].label} (${counts[readToggleAction]})`"
                :severity="BULK_ACTION_META[readToggleAction].severity"
                :text="BULK_ACTION_META[readToggleAction].text"
                size="small"
                :loading="busy"
                :title="BULK_ACTION_META[readToggleAction].tooltip"
                @click="emit('action', readToggleAction)"
            />
            <Button
                v-else-if="counts[action]"
                :icon="BULK_ACTION_META[action].icon"
                :label="`${BULK_ACTION_META[action].label} (${counts[action]})`"
                :severity="BULK_ACTION_META[action].severity"
                :text="BULK_ACTION_META[action].text"
                size="small"
                :loading="busy"
                :title="BULK_ACTION_META[action].tooltip"
                @click="emit('action', action)"
            />
        </template>
    </div>
</template>

<style scoped>
/* Sticky toolbar at the top of the inbox list. Scoped: dark-mode
   overrides extracted to styles/theme-dark.css (#B.196 Layer 0); the
   hide-on-mobile rule in App.vue uses !important so it still wins
   over scoped specificity. */
.bulk-bar {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.4rem;
    background: var(--p-surface-50);
    position: sticky;
    top: 0;
    z-index: 5;
}
.bulk-bar--bottom {
    position: sticky;
    top: auto;
    bottom: 0;
    margin-top: 0.4rem;
}

/* #B.255 fazk7z: on phone, the bar is purely a feedback panel for
   long-press selection — hide it entirely when nothing is selected
   so the inbox doesn't carry a permanent footer for a UX that's
   gesture-driven. Desktop still shows the "select all" button as a
   discoverable affordance. */
@media (max-width: 720px) {
    .bulk-bar:not(.bulk-bar--has-selection) {
        display: none;
    }
    /* #B.255 hekhbc: don't cram every action button onto one row —
       on phone the actions get crushed in width. Let them wrap into
       an "icon panel" laid out across multiple rows below the
       count. The spacer pseudo-breaks the line so the action group
       always starts on its own row, regardless of selection size. */
    .bulk-bar {
        flex-wrap: wrap;
        row-gap: 0.4rem;
    }
    .bulk-bar .spacer {
        flex: 0 0 100%;
        height: 0;
    }
}
.bulk-count {
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
}
</style>
