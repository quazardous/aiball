<script setup lang="ts">
import { ref, computed } from "vue";
import Button from "primevue/button";
import IdentityPicker from "./IdentityPicker.vue";
import type { Strategy } from "../lib/api";
import { HEADER_BADGE_TOOLTIPS } from "../lib/labels";

export interface StrategyOption {
    label: string;
    value: Strategy;
    hint: string;
    icon: string;
}

const props = defineProps<{
    connected: boolean;
    globalPendingCount: number;
    globalResolvedCount: number;
    globalUnreadCount: number;
    globalSnoozedCount: number;
    globalOpenCount: number;
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

// #B.161: native <details> CSS dropdown for the strategy picker. The
// summary shows the current strategy (icon + label on desktop,
// icon-only on mobile via CSS). Body lists the options as buttons;
// picking one emits update:strategy and closes the details.
const strategyOpen = ref(false);
const currentStrategy = computed(() => props.strategyOptions.find((o) => o.value === props.strategy));
function pickStrategy(v: Strategy) {
    emit("update:strategy", v);
    strategyOpen.value = false;
}
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
            v-if="globalOpenCount > 0"
            class="header-badge header-badge--open"
            :title="`${globalOpenCount} open ticket${globalOpenCount > 1 ? 's' : ''} across all projects`"
        >
            <i class="pi pi-ticket" /> {{ globalOpenCount }}
        </span>
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
        <details
            class="strategy-dropdown"
            :open="strategyOpen"
            :title="currentStrategy?.hint"
            @toggle="(e: Event) => strategyOpen = (e.target as HTMLDetailsElement).open"
        >
            <summary class="strategy-dropdown__summary">
                <i v-if="currentStrategy" :class="currentStrategy.icon" />
                <span class="strategy-dropdown__label">{{ currentStrategy?.label ?? "..." }}</span>
                <i class="pi pi-chevron-down strategy-dropdown__chev" />
            </summary>
            <div class="strategy-dropdown__menu">
                <button
                    v-for="o in strategyOptions"
                    :key="o.value"
                    type="button"
                    class="strategy-dropdown__item"
                    :class="{ 'strategy-dropdown__item--current': o.value === strategy }"
                    :title="o.hint"
                    @click="pickStrategy(o.value)"
                >
                    <i :class="o.icon" />
                    <span>{{ o.label }}</span>
                    <i v-if="o.value === strategy" class="pi pi-check strategy-dropdown__check" />
                </button>
            </div>
        </details>
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

<style>
.aiball-header {
    display: flex;
    align-items: center;
    /* #B.161: allow header to wrap on narrow viewports so controls
       don't clip off the right edge. Tight gap keeps the wrapped row
       readable. */
    flex-wrap: wrap;
    gap: 0.4rem 0.6rem;
    padding: 0.5rem 0.7rem;
    border-bottom: 1px solid var(--p-content-border-color);
    background: var(--p-content-background);
    position: sticky;
    top: 0;
    z-index: 10;
}
@media (max-width: 720px) {
    .aiball-header {
        /* On the wrapped layout the spacer would push half the
           controls to a third line — collapse it so all controls
           stay on at most two rows. #B.161 compact pass: tighter
           gap + smaller h1 + hide the strategy-select (rarely
           changed; accessible via Project Settings). #B.161
           follow-up: tighter inline gap between icon buttons on
           the wrapped row (david: "beaucoup trop d'espace entre
           les icone bouton ici"). */
        gap: 0.2rem 0.15rem;
        padding: 0.35rem 0.45rem;
    }
    /* PrimeVue rounded buttons in the header (notif, dark, refresh,
       auto-refresh) had visible inter-button space from their own
       :not(:last-child) margin + the header gap. Strip margin so the
       row reads as a tight cluster. */
    .aiball-header .p-button.p-button-rounded {
        margin: 0;
    }
    .aiball-header h1 {
        font-size: 1rem;
    }
    .aiball-header .spacer {
        display: none;
    }
    /* Compact strategy dropdown on mobile: icon-only summary, taps
       expand the menu. The menu is `position: fixed` anchored to the
       viewport's right edge so it stays on-screen regardless of where
       the summary lives in the wrapped header row (was: position
       absolute right:0 which aligned to the summary's right edge —
       and the summary itself was near the viewport edge, so the menu
       extended past it). (#B.161) */
    .strategy-dropdown__label {
        display: none;
    }
    .strategy-dropdown > summary {
        padding: 0.3rem 0.4rem;
        gap: 0.25rem;
    }
    .strategy-dropdown__menu {
        position: fixed;
        top: auto;
        right: 0.5rem;
        left: auto;
        min-width: 12rem;
        max-width: calc(100vw - 1rem);
    }
    .header-badge {
        font-size: 0.72rem;
        padding: 0.1rem 0.4rem;
    }
}
.aiball-header h1 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
}
.aiball-header .spacer {
    flex: 1;
}
.connection-dot {
    display: inline-block;
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    background: #888;
}
.connection-dot.live {
    background: #22c55e;
}
.connection-dot.offline {
    background: #ef4444;
}
/* #B.161: strategy picker as a native <details> dropdown so it's
   compact on mobile (icon-only summary) and full-label on desktop.
   The browser handles open/close on summary click; outside-click
   closing is delegated to the toggle event + a body-level click
   listener (kept inline here via CSS-only behavior — clicking
   another summary just doesn't close this one; user clicks again
   to close. Acceptable trade-off for native dropdown). */
.strategy-dropdown {
    position: relative;
    margin-left: 0.4rem;
}
.strategy-dropdown > summary {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.55rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.4rem;
    background: var(--p-surface-0);
    cursor: pointer;
    font-size: 0.85rem;
    list-style: none;
    user-select: none;
}
.strategy-dropdown > summary::-webkit-details-marker { display: none; }
.aiball-dark .strategy-dropdown > summary {
    background: var(--p-surface-800);
}
.strategy-dropdown__chev {
    font-size: 0.65rem;
    color: var(--p-text-muted-color);
    transition: transform 0.15s;
}
.strategy-dropdown[open] .strategy-dropdown__chev {
    transform: rotate(180deg);
}
.strategy-dropdown__menu {
    position: absolute;
    top: calc(100% + 0.25rem);
    left: 0;
    min-width: 14rem;
    background: var(--p-content-background);
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.4rem;
    box-shadow: 0 6px 16px rgba(0,0,0,0.12);
    z-index: 20;
    padding: 0.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
}
.strategy-dropdown__item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem;
    background: transparent;
    border: 0;
    border-radius: 0.3rem;
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
    color: var(--p-text-color);
}
.strategy-dropdown__item:hover {
    background: var(--p-surface-100);
}
.aiball-dark .strategy-dropdown__item:hover {
    background: var(--p-surface-800);
}
.strategy-dropdown__item--current {
    color: var(--p-primary-color);
    font-weight: 600;
}
.strategy-dropdown__check {
    margin-left: auto;
    font-size: 0.75rem;
}
.header-badge {
    font-size: 0.78rem;
    font-weight: 600;
    border-radius: 999px;
    padding: 0.15rem 0.5rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
}
.header-badge--open {
    /* Muted grey/neutral — the at-a-glance "active backlog" count.
     * Stays calm so the priority badges (pending / unread / resolved)
     * dominate visually. */
    background: var(--p-surface-200);
    color: var(--p-text-color);
}
.aiball-dark .header-badge--open {
    background: var(--p-surface-700);
    color: var(--p-text-color);
}
.header-badge--pending {
    background: var(--p-yellow-500);
    color: black;
}
.header-badge--unread {
    background: var(--p-blue-500);
    color: white;
}
.header-badge--resolved {
    background: var(--p-green-500);
    color: white;
}
.header-badge--snoozed {
    /* Clickable toggle — off = muted indigo (just a count), on = solid
     * indigo (active state, snoozed rows are surfaced everywhere). */
    background: color-mix(in srgb, var(--p-indigo-500) 25%, transparent);
    color: var(--p-indigo-700);
    border: 1px solid color-mix(in srgb, var(--p-indigo-500) 40%, transparent);
    cursor: pointer;
    font-family: inherit;
}
.header-badge--snoozed:hover {
    background: color-mix(in srgb, var(--p-indigo-500) 35%, transparent);
}
.header-badge--snoozed.header-badge--snoozed-on {
    background: var(--p-indigo-500);
    color: white;
    border-color: var(--p-indigo-500);
}
.aiball-dark .header-badge--snoozed {
    color: var(--p-indigo-200);
}
.aiball-dark .header-badge--snoozed.header-badge--snoozed-on {
    color: white;
}
</style>
