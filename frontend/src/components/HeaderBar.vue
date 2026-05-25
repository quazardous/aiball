<script setup lang="ts">
import Button from "primevue/button";
import IdentityPicker from "./IdentityPicker.vue";
import { HEADER_BADGE_TOOLTIPS } from "../lib/labels";

// #438: the moderation-strategy picker moved out of the header into the
// dedicated Settings > General page (GeneralSettingsPanel) — david wanted
// "une vraie page settings globale" rather than a head dropdown.
// #445: the notifications control ("enable alerts" + mute toggle) likewise
// moved out of the header into Settings > General, same rationale.
defineProps<{
    connected: boolean;
    globalPendingCount: number;
    globalResolvedCount: number;
    globalUnreadCount: number;
    globalSnoozedCount: number;
    globalOpenCount: number;
    showSnoozed: boolean;
    dark: boolean;
    loading: boolean;
    autoRefresh: boolean;
}>();
const emit = defineEmits<{
    (e: "update:showSnoozed", v: boolean): void;
    (e: "update:dark", v: boolean): void;
    (e: "update:autoRefresh", v: boolean): void;
    (e: "refresh"): void;
    // #456: click the unread badge → mark all notifications read (clears the
    // cross-project / pending backlog the inbox mark-read can't reach).
    (e: "mark-all-read"): void;
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
        <button
            v-if="globalUnreadCount > 0"
            type="button"
            class="header-badge header-badge--unread"
            :title="`${HEADER_BADGE_TOOLTIPS.unread(globalUnreadCount)} — click to mark all read`"
            @click="emit('mark-all-read')"
        >
            <i class="pi pi-envelope" /> {{ globalUnreadCount }}
        </button>
        <button
            type="button"
            class="header-badge header-badge--snoozed"
            :class="{ 'header-badge--snoozed-on': showSnoozed }"
            :title="HEADER_BADGE_TOOLTIPS.snoozed(globalSnoozedCount, showSnoozed)"
            @click="emit('update:showSnoozed', !showSnoozed)"
        >
            <i class="pi pi-history" /> {{ globalSnoozedCount }}
        </button>
        <span class="spacer" />
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
    /* #B.161 / #445: labelled header buttons (now the IdentityPicker's
       consumer name) eat horizontal space — on mobile, drop the label so
       the icon stays the only affordance (tooltip via title attr remains). */
    .aiball-header .p-button-label {
        display: none;
    }
    .aiball-header h1 {
        font-size: 1rem;
    }
    .aiball-header .spacer {
        display: none;
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
.header-badge--pending {
    background: var(--p-yellow-500);
    color: black;
}
.header-badge--unread {
    background: var(--p-blue-500);
    color: white;
    /* #456: clickable → mark all read. */
    border: 0;
    cursor: pointer;
    font: inherit;
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
</style>
