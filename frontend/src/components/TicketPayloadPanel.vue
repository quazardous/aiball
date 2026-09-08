<script setup lang="ts">
/**
 * #2112 — the payload zone on a ticket thread.
 *
 * Mounted ONLY when the ticket's `has_payload` is true, which is what makes
 * david's constraint literal: "si pas de payload doit être complètement
 * invisible". Not an empty panel — no panel, and no request either. The flag
 * rides along on the ticket read, so a ticket without a payload costs nothing.
 *
 * What this panel deliberately does NOT have is a reveal button. The values do
 * not travel to the browser at all: the API hands back keys and public values,
 * with secrets already reduced to a prefix. Reaching a secret is
 * `aiball payload dump`, a command someone runs on purpose.
 *
 * Revoking, by contrast, IS a human gesture and belongs here.
 */
import { computed, ref } from "vue";
import { useConfirm } from "primevue/useconfirm";
import Button from "primevue/button";
import { api, type PayloadView } from "../lib/api";
import { useNotify } from "../lib/notify";
import { useLoader } from "../lib/loader";
import PayloadNode from "./PayloadNode.vue";

const props = defineProps<{ ticketId: number }>();

const data = ref<PayloadView | null>(null);
const error = ref<string | null>(null);
const notify = useNotify();
const confirm = useConfirm();
const revokeBusy = ref(false);

// `mountLoad` fires the fetch on mount, and the panel is only ever mounted for
// a ticket that has a payload — so this request never goes out on a ticket
// without one.
const { loading } = useLoader(async () => {
    data.value = await api.getTicketPayload(props.ticketId);
}, { error, mountLoad: true });

const access = computed(() => data.value?.access ?? "open");
const revoked = computed(() => access.value === "revoked");

/** Entries of the filtered payload, in the order the depositor wrote them. */
const entries = computed<[string, unknown][]>(() =>
    Object.entries(data.value?.payload ?? {}),
);

/** The keys a revoked payload used to hold — kept on the tombstone so the
 *  thread can still say WHICH credential was destroyed, not merely that one
 *  was. */
const tombstoneKeys = computed(() => data.value?.keys ?? []);

function confirmRevoke() {
    confirm.require({
        header: "Revoke payload",
        message:
            "Destroy the values on this ticket? The keys and a record of the revocation are kept; the values themselves are gone for good.",
        icon: "pi pi-lock",
        acceptLabel: "Revoke",
        rejectLabel: "Cancel",
        acceptClass: "p-button-danger",
        accept: () => { void doRevoke(); },
    });
}

async function doRevoke() {
    revokeBusy.value = true;
    try {
        data.value = await api.revokeTicketPayload(props.ticketId);
        notify.success("Payload revoked");
    } catch (e) {
        notify.error("Revoke failed", { detail: (e as Error).message });
    } finally {
        revokeBusy.value = false;
    }
}
</script>

<template>
    <section class="payload-panel">
        <header class="payload-panel__head">
            <i class="pi pi-box payload-panel__icon" />
            <span class="payload-panel__title">payload</span>
            <span
                v-if="access !== 'open'"
                class="payload-panel__state"
                :class="revoked ? 'payload-panel__state--revoked' : 'payload-panel__state--closed'"
            >{{ revoked ? "revoked" : "ticket closed" }}</span>
            <span class="payload-panel__spacer" />
            <Button
                v-if="!revoked"
                label="Revoke"
                icon="pi pi-lock"
                size="small"
                severity="danger"
                text
                :loading="revokeBusy"
                @click="confirmRevoke"
            />
        </header>

        <p v-if="loading" class="payload-panel__note">loading…</p>
        <p v-else-if="error" class="payload-panel__note payload-panel__note--error">{{ error }}</p>

        <template v-else-if="revoked">
            <p class="payload-panel__note">
                Values destroyed<template v-if="data?.revoked_by"> by {{ data.revoked_by }}</template>
                <template v-if="data?.revoked_at"> on {{ new Date(data.revoked_at).toLocaleString() }}</template>.
                <template v-if="tombstoneKeys.length">
                    It held<template v-for="(k, i) in tombstoneKeys" :key="k"><span v-if="i">,</span>
                        <code>{{ k }}</code></template>.
                </template>
            </p>
        </template>

        <template v-else>
            <div class="payload-panel__tree">
                <PayloadNode
                    v-for="[key, value] in entries"
                    :key="key"
                    :label="key"
                    :value="value"
                    :depth="0"
                />
            </div>
            <p class="payload-panel__note">
                <template v-if="access === 'ticket-closed'">
                    The ticket is closed, so the values are out of reach — reopen it to read them.
                </template>
                <template v-else>
                    Values are not sent to the browser. Read them with
                    <code>aiball payload dump --id {{ ticketId }} --to &lt;file&gt;</code>.
                </template>
            </p>
        </template>
    </section>
</template>

<style>
.payload-panel {
    border: 1px solid var(--p-content-border-color, #e5e7eb);
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    margin: 0.75rem 0;
    background: var(--p-content-background, transparent);
}
.payload-panel__head {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin-bottom: 0.35rem;
}
.payload-panel__icon { opacity: 0.6; font-size: 0.85rem; }
.payload-panel__title {
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--p-text-muted-color, #6b7280);
}
.payload-panel__spacer { flex: 1; }
.payload-panel__state {
    font-size: 0.7rem;
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}
.payload-panel__state--revoked {
    color: var(--p-red-500, #ef4444);
    border: 1px solid currentColor;
    opacity: 0.75;
}
.payload-panel__state--closed {
    color: var(--p-text-muted-color, #6b7280);
    border: 1px solid currentColor;
    opacity: 0.6;
}
.payload-panel__tree { margin: 0.2rem 0 0.4rem; }
.payload-panel__note {
    margin: 0;
    font-size: 0.75rem;
    color: var(--p-text-muted-color, #6b7280);
}
.payload-panel__note--error { color: var(--p-red-500, #ef4444); }
.payload-panel__note code {
    font-size: 0.72rem;
    background: var(--p-content-hover-background, rgba(127, 127, 127, 0.1));
    padding: 0 0.2rem;
    border-radius: 3px;
}
</style>
