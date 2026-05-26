<script setup lang="ts">
// #438: global (daemon-wide) settings page, under the Settings menu. Today it
// hosts the moderation-strategy GLOBAL default (moved out of the header — david:
// "créer une vraie page settings globale") and, since #445, the notifications
// control (also moved out of the header). Room to grow (upload caps, etc.).
// Stays a thin presentational panel: state is owned by App.vue (strategy kept in
// sync with the WS `strategy_changed`; notif state from useNotifications),
// passed in + emitted back like HeaderBar did.
import { ref } from "vue";
import Button from "primevue/button";
import { useConfirm } from "primevue/useconfirm";
import { api, type Strategy } from "../lib/api";
import { bus } from "../lib/bus";
import { useNotify } from "../lib/notify";
import ManagedConfig from "./ManagedConfig.vue";
import PanelHeader from "./ui/PanelHeader.vue";

type LayoutMode = "spread" | "narrow";

defineProps<{
    strategy: Strategy;
    strategyOptions: { label: string; value: Strategy; hint: string; icon: string }[];
    // #445: per-device browser-notification state, owned by App.vue's
    // useNotifications. notifAllowed = OS permission granted; notifMuted = user
    // silenced them in-app even though permission is granted.
    notifAllowed: boolean;
    notifMuted: boolean;
    // #462: per-device layout density. `spread` = wide cap (default), `narrow`
    // = historical 980px cap. Owned by App.vue, persisted in localStorage.
    layoutMode: LayoutMode;
}>();
const emit = defineEmits<{
    (e: "update:strategy", v: Strategy): void;
    (e: "enable-notif"): void;
    (e: "toggle-mute"): void;
    (e: "update:layout-mode", v: LayoutMode): void;
}>();

// #475 david : global "Purge tickets closed > 1 year". Même sémantique
// que la Danger zone per-projet de ProjectOverviewPage, mais sweep TOUS
// les projets côté daemon (endpoint POST /api/tickets/purge). State
// local — la panel reste presentational pour tout le reste, ici on a
// juste un busy flag + un confirm + un toast.
const confirmDialog = useConfirm();
const notify = useNotify();
const purgingAll = ref(false);

function confirmPurgeAll() {
    confirmDialog.require({
        header: "Purge old closed tickets — ALL projects",
        message:
            "Purge tickets closed more than 1 year ago across EVERY project? "
            + "Open tickets, comments on still-open tickets, and recently-closed "
            + "tickets are left intact. This walks every project in turn.",
        icon: "pi pi-eraser",
        acceptLabel: "Purge all projects",
        rejectLabel: "Cancel",
        acceptClass: "p-button-warn",
        accept: () => { void doPurgeAll(); },
    });
}
async function doPurgeAll() {
    purgingAll.value = true;
    try {
        const r = await api.purgeAllOldClosed(365);
        if (r.purged_tickets === 0) {
            notify.info("Nothing to purge", {
                detail: `No tickets closed more than ${r.older_than_days} days ago across any project.`,
            });
        } else {
            const touched = r.per_project.filter((p) => p.purged_tickets > 0);
            notify.success(`Purged ${r.purged_tickets} ticket(s) across ${touched.length} project(s)`, {
                detail: `${r.purged_messages} message(s) removed (closed > ${r.older_than_days}d).`,
            });
        }
        bus.emit("projects.refresh");
        bus.emit("inbox.refresh");
    } catch (e) {
        notify.error("Purge failed", { detail: (e as Error).message });
    } finally {
        purgingAll.value = false;
    }
}
</script>

<template>
    <div class="general-settings">
        <PanelHeader title="General" />

        <section class="general-settings__section">
            <h3 class="general-settings__heading">Moderation strategy</h3>
            <p class="general-settings__hint">
                Daemon-wide default for how new tickets and replies are moderated.
                Each project can override it in its own settings — projects left on
                <em>“Use global”</em> follow this default.
            </p>
            <div class="general-settings__options">
                <button
                    v-for="o in strategyOptions"
                    :key="o.value"
                    type="button"
                    class="general-settings__option"
                    :class="{ 'general-settings__option--current': o.value === strategy }"
                    @click="emit('update:strategy', o.value)"
                >
                    <i :class="o.icon" class="general-settings__option-icon" />
                    <span class="general-settings__option-text">
                        <span class="general-settings__option-label">{{ o.label }}</span>
                        <span class="general-settings__option-desc">{{ o.hint }}</span>
                    </span>
                    <i v-if="o.value === strategy" class="pi pi-check general-settings__option-check" />
                </button>
            </div>
        </section>

        <!-- #445: notifications control, moved here from the header (david). -->
        <section class="general-settings__section">
            <h3 class="general-settings__heading">Notifications</h3>
            <p class="general-settings__hint">
                Browser/OS alerts when something needs your attention (new pending
                tickets, replies). Granted and silenced <em>per device</em> — each
                browser keeps its own permission.
            </p>
            <div class="general-settings__options">
                <button
                    v-if="!notifAllowed && !notifMuted"
                    type="button"
                    class="general-settings__option"
                    @click="emit('enable-notif')"
                >
                    <i class="pi pi-bell general-settings__option-icon" />
                    <span class="general-settings__option-text">
                        <span class="general-settings__option-label">Enable browser notifications</span>
                        <span class="general-settings__option-desc">Ask this browser for permission to show OS alerts.</span>
                    </span>
                </button>
                <button
                    v-else
                    type="button"
                    class="general-settings__option general-settings__option--current"
                    @click="emit('toggle-mute')"
                >
                    <i :class="['pi', notifMuted ? 'pi-bell-slash' : 'pi-bell', 'general-settings__option-icon']" />
                    <span class="general-settings__option-text">
                        <span class="general-settings__option-label">{{ notifMuted ? "Notifications muted" : "Notifications on" }}</span>
                        <span class="general-settings__option-desc">{{ notifMuted ? "Click to unmute on this device." : "Click to mute on this device." }}</span>
                    </span>
                </button>
            </div>
        </section>

        <!-- #462: layout density preference, per-device. Spread (default) uses
             the available screen width; Narrow reverts to the historical 980px
             column for users who prefer the tighter reading experience. -->
        <section class="general-settings__section">
            <h3 class="general-settings__heading">Layout density</h3>
            <p class="general-settings__hint">
                How wide content uses the screen. Saved per device — each browser
                keeps its own preference. The compose form stays narrow either way.
            </p>
            <div class="general-settings__options">
                <button
                    type="button"
                    class="general-settings__option"
                    :class="{ 'general-settings__option--current': layoutMode === 'spread' }"
                    @click="emit('update:layout-mode', 'spread')"
                >
                    <i class="pi pi-arrows-h general-settings__option-icon" />
                    <span class="general-settings__option-text">
                        <span class="general-settings__option-label">Spread</span>
                        <span class="general-settings__option-desc">Use the full width (up to 1600px). Best for wide screens.</span>
                    </span>
                    <i v-if="layoutMode === 'spread'" class="pi pi-check general-settings__option-check" />
                </button>
                <button
                    type="button"
                    class="general-settings__option"
                    :class="{ 'general-settings__option--current': layoutMode === 'narrow' }"
                    @click="emit('update:layout-mode', 'narrow')"
                >
                    <i class="pi pi-align-center general-settings__option-icon" />
                    <span class="general-settings__option-text">
                        <span class="general-settings__option-label">Narrow</span>
                        <span class="general-settings__option-desc">Historical 980px centred column. Tighter reading.</span>
                    </span>
                    <i v-if="layoutMode === 'narrow'" class="pi pi-check general-settings__option-check" />
                </button>
            </div>
        </section>

        <!-- #449: schema-driven config keys (global layer). Same component
             renders the per-project layer on the Project Settings page. -->
        <section class="general-settings__section">
            <h3 class="general-settings__heading">Managed config</h3>
            <p class="general-settings__hint">
                Daemon-wide defaults declared in the config schema. A project can
                override the project-scoped ones in its own settings.
            </p>
            <ManagedConfig />
        </section>

        <!-- #475 david : "danger zone globale pour purger les tickets fermés
             depuis + 1 an". Same look as the per-project Danger zone, but
             sweeps EVERY project at once. Single button — Delete-project
             is intentionally NOT here (a global "delete every project"
             would be too destructive; per-project keeps that affordance). -->
        <section class="general-settings__section general-settings__danger">
            <h3 class="general-settings__heading">Danger zone</h3>
            <p class="general-settings__hint">
                Maintenance actions that span every project at once. Gated by
                a confirmation dialog — no stray clicks.
            </p>
            <div class="general-settings__danger-actions">
                <Button
                    icon="pi pi-eraser"
                    label="Purge tickets closed > 1 year (all projects)"
                    severity="warn"
                    outlined
                    :loading="purgingAll"
                    @click="confirmPurgeAll"
                />
            </div>
        </section>
    </div>
</template>

<style>
.general-settings {
    padding: 0.5rem 0.2rem;
    max-width: 42rem;
}
/* En-tête → <PanelHeader> (style.css). */
.general-settings__section {
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.6rem;
    padding: 1rem 1.1rem;
}
.general-settings__heading {
    margin: 0 0 0.3rem;
    font-size: 1rem;
}
.general-settings__hint {
    margin: 0 0 0.8rem;
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
    line-height: 1.5;
}
.general-settings__options {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}
.general-settings__option {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    padding: 0.6rem 0.7rem;
    background: var(--p-surface-0);
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.45rem;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: var(--p-text-color);
    transition: background 0.1s, border-color 0.1s;
}
.general-settings__option:hover {
    background: var(--p-surface-100);
}
.general-settings__option--current {
    border-color: var(--p-primary-color);
    background: color-mix(in srgb, var(--p-primary-color) 6%, transparent);
}
.general-settings__option-icon {
    font-size: 1rem;
    color: var(--p-text-muted-color);
}
.general-settings__option-text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
}
.general-settings__option-label {
    font-weight: 600;
    font-size: 0.9rem;
}
.general-settings__option-desc {
    font-size: 0.8rem;
    color: var(--p-text-muted-color);
}
.general-settings__option-check {
    margin-left: auto;
    color: var(--p-primary-color);
}
/* #475 : Danger zone — même rendu que ProjectOverviewPage's
   .project-overview__danger (cadre rouge tinté). */
.general-settings__danger {
    border-color: color-mix(in srgb, var(--p-red-500) 25%, var(--p-content-border-color));
    background: color-mix(in srgb, var(--p-red-500) 3%, transparent);
}
.general-settings__danger .general-settings__heading {
    color: var(--p-red-600);
}
.general-settings__danger-actions {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin-top: 0.3rem;
}
</style>
