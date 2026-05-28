<script setup lang="ts">
import { ref } from "vue";
import Button from "primevue/button";
import IdentityPicker from "./IdentityPicker.vue";
import { HEADER_BADGE_TOOLTIPS } from "../lib/labels";

// #540 david : goto ticket — input compact dans le header qui accepte un
// numéro de ticket (avec ou sans `#`) et navigate vers `/b/N`. Le router
// dans App.vue picke ensuite l'openTicketId via parseUrl. Pas de hashid
// pour l'instant (hashids = comments-only, et `/b/<hashid>` n'est pas
// route-parsé côté frontend ; lookup int suffit pour l'usage « j'ai vu
// #538 mentionné, je veux y sauter »).
const gotoInput = ref("");
function submitGoto() {
    const raw = gotoInput.value.trim().replace(/^#/, "");
    const id = parseInt(raw, 10);
    if (!Number.isNaN(id) && id > 0) {
        window.history.pushState({}, "", `/b/${id}`);
        // Trigger the router's popstate watcher in App.vue.
        window.dispatchEvent(new PopStateEvent("popstate"));
        gotoInput.value = "";
    }
}

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
}>();
// #539 david : refresh + auto-refresh buttons retirés. WS reverse (`useInboxWs`)
// pousse les updates inbox en temps réel — pas besoin de polling manuel ou auto.
const emit = defineEmits<{
    (e: "update:showSnoozed", v: boolean): void;
    (e: "update:dark", v: boolean): void;
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
        <span class="spacer" />
        <form class="header-goto" @submit.prevent="submitGoto">
            <input
                v-model="gotoInput"
                type="text"
                inputmode="numeric"
                pattern="#?[0-9]+"
                placeholder="#N"
                title="Go to ticket — type a ticket number (e.g. 540) and press Enter"
                class="header-goto__input"
            />
        </form>
        <IdentityPicker />
        <Button
            :icon="dark ? 'pi pi-sun' : 'pi pi-moon'"
            severity="secondary"
            text
            rounded
            @click="emit('update:dark', !dark)"
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
    /* PrimeVue rounded buttons in the header (notif, dark) had visible
       inter-button space from their own :not(:last-child) margin + the
       header gap. Strip margin so the row reads as a tight cluster. */
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
/* #540 — goto ticket input : compact, mono, blends-in. */
.header-goto {
    display: inline-flex;
    align-items: center;
    margin: 0;
}
.header-goto__input {
    width: 4.5rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.3rem;
    background: var(--p-surface-50);
    color: var(--p-text-color);
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.85rem;
    text-align: center;
}
.header-goto__input:focus {
    outline: none;
    border-color: var(--p-primary-color);
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
