<script setup lang="ts">
import Button from "primevue/button";
import { type BulkAction } from "../lib/ticket-actions";

export type BulkCounts = Record<BulkAction, number>;

defineProps<{
    selectedSize: number;
    counts: BulkCounts;
    busy: boolean;
}>();

const emit = defineEmits<{
    (e: "clear"): void;
    (e: "select-all"): void;
    (e: "action", action: BulkAction): void;
}>();

function trigger(action: BulkAction) {
    emit("action", action);
}
</script>

<template>
    <div class="bulk-bar bulk-bar--bottom">
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
        <Button
            v-if="counts.mark_read || counts.mark_unread"
            :icon="counts.mark_read >= counts.mark_unread ? 'pi pi-envelope-open' : 'pi pi-envelope'"
            :label="counts.mark_read >= counts.mark_unread ? `read (${counts.mark_read})` : `unread (${counts.mark_unread})`"
            severity="secondary"
            text
            size="small"
            :loading="busy"
            :title="counts.mark_read >= counts.mark_unread
                ? 'Mark the selected unread tickets as read (others skipped)'
                : 'Mark the selected read tickets as unread (others skipped)'"
            @click="trigger(counts.mark_read >= counts.mark_unread ? 'mark_read' : 'mark_unread')"
        />
        <Button
            v-if="counts.snooze"
            icon="pi pi-history"
            :label="`snooze (${counts.snooze})`"
            severity="info"
            text
            size="small"
            :loading="busy"
            title="Snooze the selected open tickets for 3 days (others skipped). Use the thread toolbar for a custom duration."
            @click="trigger('snooze')"
        />
        <Button
            v-if="counts.unsnooze"
            icon="pi pi-bell"
            :label="`unsnooze (${counts.unsnooze})`"
            severity="info"
            text
            size="small"
            :loading="busy"
            title="Bring the selected snoozed tickets back to the open inbox now."
            @click="trigger('unsnooze')"
        />
        <Button
            v-if="counts.close"
            icon="pi pi-lock"
            :label="`close (${counts.close})`"
            severity="warn"
            text
            size="small"
            :loading="busy"
            title="Close the selected open tickets (others skipped). Only the reporter / human can close."
            @click="trigger('close')"
        />
        <Button
            v-if="counts.reopen"
            icon="pi pi-unlock"
            :label="`reopen (${counts.reopen})`"
            severity="info"
            text
            size="small"
            :loading="busy"
            title="Reopen the selected closed tickets (others skipped)."
            @click="trigger('reopen')"
        />
        <Button
            v-if="counts.approve"
            :label="`approve (${counts.approve})`"
            icon="pi pi-check"
            severity="success"
            size="small"
            :loading="busy"
            title="Approve the selected pending tickets (others skipped)."
            @click="trigger('approve')"
        />
        <Button
            v-if="counts.reject"
            :label="`reject (${counts.reject})`"
            icon="pi pi-times"
            severity="danger"
            size="small"
            :loading="busy"
            title="Reject the selected pending tickets (others skipped)."
            @click="trigger('reject')"
        />
    </div>
</template>
