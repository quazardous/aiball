<script setup lang="ts">
import Button from "primevue/button";
import Select from "primevue/select";
import IdentityPicker from "./IdentityPicker.vue";
import type { Strategy } from "../lib/api";
import { HEADER_BADGE_TOOLTIPS } from "../lib/labels";

export interface StrategyOption {
    label: string;
    value: Strategy;
    hint: string;
}

defineProps<{
    connected: boolean;
    globalPendingCount: number;
    globalResolvedCount: number;
    globalUnreadCount: number;
    globalSnoozedCount: number;
    showSnoozed: boolean;
    strategy: Strategy;
    strategyOptions: StrategyOption[];
    notifAllowed: boolean;
    notifMuted: boolean;
    dark: boolean;
    loading: boolean;
    autoRefresh: boolean;
}>();

const emit = defineEmits<{
    (e: "update:showSnoozed", v: boolean): void;
    (e: "update:strategy", v: Strategy): void;
    (e: "update:dark", v: boolean): void;
    (e: "update:autoRefresh", v: boolean): void;
    (e: "enable-notif"): void;
    (e: "toggle-mute"): void;
    (e: "refresh"): void;
}>();
</script>

<template>
    <header class="aiball-header">
        <h1>aiball</h1>
        <span
            class="connection-dot"
            :class="connected ? 'live' : 'offline'"
            :title="connected ? 'WebSocket live' : 'WebSocket offline'"
        />
        <span
            v-if="globalPendingCount > 0"
            class="header-badge header-badge--pending"
            :title="HEADER_BADGE_TOOLTIPS.pending(globalPendingCount)"
        >
            <i class="pi pi-clock" /> {{ globalPendingCount }}
        </span>
        <span
            v-if="globalResolvedCount > 0"
            class="header-badge header-badge--resolved"
            :title="HEADER_BADGE_TOOLTIPS.resolved(globalResolvedCount)"
        >
            <i class="pi pi-check-circle" /> {{ globalResolvedCount }}
        </span>
        <span
            v-if="globalUnreadCount > 0"
            class="header-badge header-badge--unread"
            :title="HEADER_BADGE_TOOLTIPS.unread(globalUnreadCount)"
        >
            <i class="pi pi-envelope" /> {{ globalUnreadCount }}
        </span>
        <button
            type="button"
            class="header-badge header-badge--snoozed"
            :class="{ 'header-badge--snoozed-on': showSnoozed }"
            :title="HEADER_BADGE_TOOLTIPS.snoozed(globalSnoozedCount, showSnoozed)"
            @click="emit('update:showSnoozed', !showSnoozed)"
        >
            <i class="pi pi-history" /> {{ globalSnoozedCount }}
        </button>
        <Select
            :model-value="strategy"
            :options="strategyOptions"
            option-label="label"
            option-value="value"
            size="small"
            class="strategy-select"
            :title="strategyOptions.find(o => o.value === strategy)?.hint"
            @update:model-value="(v: Strategy) => emit('update:strategy', v)"
        />
        <span class="spacer" />
        <Button
            v-if="!notifAllowed && !notifMuted"
            icon="pi pi-bell"
            label="enable alerts"
            size="small"
            severity="secondary"
            text
            @click="emit('enable-notif')"
        />
        <Button
            v-else
            :icon="notifMuted ? 'pi pi-bell-slash' : 'pi pi-bell'"
            :title="notifMuted ? 'OS notifications muted' : 'OS notifications on'"
            severity="secondary"
            text
            rounded
            @click="emit('toggle-mute')"
        />
        <IdentityPicker />
        <Button
            :icon="dark ? 'pi pi-sun' : 'pi pi-moon'"
            severity="secondary"
            text
            rounded
            @click="emit('update:dark', !dark)"
        />
        <Button
            icon="pi pi-refresh"
            severity="secondary"
            text
            rounded
            :loading="loading"
            @click="emit('refresh')"
        />
        <Button
            :icon="autoRefresh ? 'pi pi-clock' : 'pi pi-stop-circle'"
            :severity="autoRefresh ? 'success' : 'secondary'"
            :title="autoRefresh ? 'Auto-refresh on (every 60s) — click to stop' : 'Auto-refresh off — click to enable (60s)'"
            text
            rounded
            @click="emit('update:autoRefresh', !autoRefresh)"
        />
    </header>
</template>
