<script setup lang="ts">
/**
 * Identity picker — post-#B.252 minimal version. Just the current
 * consumer label + a logout action under a popover. The agent-
 * switching AutoComplete + Reset/Apply controls were retired in
 * #suchxy / #s36n59 (david: "même le drop down de choix sert à
 * rien"); identity in single-user setups is whatever the login
 * gave you and that doesn't get reshuffled day-to-day.
 *
 * Storage:
 *   - `aiball.me`       — authed login (set by Setup/Login).
 *   - `aiball.human_id` — kept around for legacy consumers but no
 *     longer mutated from this popover; the API client just reads
 *     it back into the X-Aiball-Consumer header on every request.
 */
import { ref } from "vue";
import Button from "primevue/button";
import Popover from "primevue/popover";
import { api, clearAuthToken } from "../lib/api";

const FALLBACK_ID = "human";

function readMe(): string {
    return localStorage.getItem("aiball.me") || FALLBACK_ID;
}
function readId(): string {
    return localStorage.getItem("aiball.human_id") || readMe();
}

const consumerId = ref<string>(readId());
const popoverRef = ref<InstanceType<typeof Popover> | null>(null);

function openPopover(event: MouseEvent) {
    // Re-read in case another tab logged in/out since last open.
    consumerId.value = readId();
    popoverRef.value?.show(event);
}

async function doLogout() {
    try {
        await api.authLogout();
    } catch {
        /* token already gone; we still log out client-side */
    }
    clearAuthToken();
    localStorage.removeItem("aiball.human_id");
    window.location.href = "/login";
}
</script>

<template>
    <Button
        icon="pi pi-user"
        :label="consumerId"
        severity="secondary"
        size="small"
        text
        :title="`Acting as ${consumerId}. Click to log out.`"
        @click="openPopover"
    />
    <Popover ref="popoverRef">
        <div class="identity-picker">
            <div class="identity-picker__current">
                Acting as <strong>{{ consumerId }}</strong>
            </div>
            <Button
                label="Log out"
                icon="pi pi-sign-out"
                size="small"
                severity="danger"
                text
                @click="doLogout"
            />
        </div>
    </Popover>
</template>

<style>
.identity-picker {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.5rem;
    min-width: 13rem;
    padding: 0.2rem;
}
.identity-picker__current {
    font-size: 0.88rem;
    color: var(--p-text-muted-color);
}
</style>
