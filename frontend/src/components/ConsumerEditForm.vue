<script setup lang="ts">
/**
 * "Edit" tab content of the consumer detail page (extracted from
 * ConsumerEditPage.vue). Editable fields + single Save action + the
 * raw-prompt injection composer (#451).
 *
 * Seam: `original` + `consumerId` in ; `saved` out (after a successful
 * save, so the parent re-loads) ; `close` out (Cancel, and after save —
 * same page-closing behaviour as before the split). The field refs are
 * (re)initialised from `original` via an immediate watch, reproducing
 * exactly the mapping the parent's load() used to do.
 */
import { ref, watch } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Textarea from "primevue/textarea";
import { api, CONSUMER_KIND_OPTIONS, type Consumer, type ConsumerKind } from "../lib/api";
import { useNotify } from "../lib/notify";
import FormField from "./ui/FormField.vue";

const props = defineProps<{ original: Consumer; consumerId: string }>();
const emit = defineEmits<{
    (e: "saved"): void;
    (e: "close"): void;
}>();

const notify = useNotify();
const saving = ref(false);

const kind = ref<ConsumerKind>("agent");
const displayName = ref("");
const note = ref("");
const microPrompt = ref("");
const enabled = ref(true);
// #508 — global flag : peut claim via engage / pool claimable (défaut true).
// Quand false → consumer "spécialiste" qui ne prend QUE les tickets explicitement
// assignés (via ticket_assign), pas le pool global.
const canClaim = ref(true);
// #516 (david `r59bkm` plan E) — tri-state opt-in pour les broadcasts projet.
// "auto" (null) = suit can_claim ; "on" = opt-in explicite ; "off" = opt-out
// explicite. Stocké en string pour le Select ; converti en boolean | null
// au save.
const notifyBroadcasts = ref<"auto" | "on" | "off">("auto");
// #451: raw-prompt injection (this dedicated page is where the operator types it).
const promptText = ref("");
const promptBusy = ref(false);

const KIND_OPTIONS = CONSUMER_KIND_OPTIONS;

// Same field mapping the parent's load() applied pre-split (including the
// notify_project_broadcasts tri-state + the can_claim default-true for
// pre-#508 rows). Re-runs on every refetch, mirroring the old behaviour.
watch(() => props.original, (found) => {
    if (!found) return;
    kind.value = found.kind;
    displayName.value = found.display_name ?? "";
    note.value = found.note ?? "";
    microPrompt.value = found.micro_prompt ?? "";
    enabled.value = found.enabled;
    canClaim.value = found.can_claim !== false; // default true if undefined (pre-#508 row)
    notifyBroadcasts.value = found.notify_project_broadcasts === true
        ? "on"
        : found.notify_project_broadcasts === false
            ? "off"
            : "auto";
}, { immediate: true });

async function save() {
    if (!props.original) return;
    saving.value = true;
    try {
        await api.updateConsumer(props.consumerId, {
            kind: kind.value,
            display_name: displayName.value.trim() || null,
            note: note.value.trim() || null,
            micro_prompt: microPrompt.value.trim() || null,
            enabled: enabled.value,
            can_claim: canClaim.value,
            notify_project_broadcasts: notifyBroadcasts.value === "on"
                ? true
                : notifyBroadcasts.value === "off"
                    ? false
                    : null,
        });
        notify.success(`Saved ${props.consumerId}`);
        emit("saved");
        emit("close");
    } catch (e) {
        notify.error("Save failed", { detail: (e as Error).message });
    } finally {
        saving.value = false;
    }
}

// #451: send a raw, unfiltered prompt to this loop. Spooled then delivered:
// live → injected now; offline → delivered when the loop's SSE reconnects.
async function sendPrompt() {
    const text = promptText.value.trim();
    if (!text) return;
    promptBusy.value = true;
    try {
        const r = await api.sendLoopPrompt(props.consumerId, text);
        if (r.delivered) {
            notify.success(`Prompt sent to ${props.consumerId}`, { detail: "Injected into the live Claude session." });
        } else {
            notify.info(`Prompt spooled for ${props.consumerId}`, { detail: "Loop offline — it'll be delivered when the loop reconnects." });
        }
        promptText.value = "";
    } catch (e) {
        notify.error("Prompt failed", { detail: (e as Error).message });
    } finally {
        promptBusy.value = false;
    }
}
</script>

<template>
    <div class="consumer-edit__tab">
        <FormField label="kind" for="ce-kind">
            <Select
                inputId="ce-kind"
                v-model="kind"
                :options="KIND_OPTIONS"
                optionLabel="label"
                optionValue="value"
                style="width: 100%"
            />
        </FormField>

        <FormField label="display name" for="ce-name">
            <InputText
                id="ce-name"
                v-model="displayName"
                placeholder="(falls back to consumer_id)"
                style="width: 100%"
            />
        </FormField>

        <FormField label="note" for="ce-note">
            <Textarea
                id="ce-note"
                v-model="note"
                rows="3"
                placeholder="(internal note — visible only on this page)"
                style="width: 100%"
            />
        </FormField>

        <FormField label="micro-prompt" for="ce-micro-prompt">
            <Textarea
                id="ce-micro-prompt"
                v-model="microPrompt"
                rows="3"
                placeholder="(standing instruction injected into this agent's wake prompt via {consumer_prompt} — e.g. &quot;branch main if the ticket doesn't specify&quot;)"
                style="width: 100%"
            />
            <small class="consumer-edit__hint">
                Surfaced to the agent on wake via the <code>{consumer_prompt}</code>
                placeholder. Opt-in: add the placeholder to your <code>wake_master</code>
                template (<code>.aiball.yaml</code>) where you want it. Empty = nothing injected.
            </small>
        </FormField>

        <FormField>
            <label>
                <input
                    type="checkbox"
                    :checked="enabled"
                    @change="enabled = ($event.target as HTMLInputElement).checked"
                />
                enabled (when off, the daemon rejects new posts from this consumer)
            </label>
        </FormField>

        <!-- #508 — global no-claim flag : consumer "spécialiste" qui ne
             prend que les tickets explicitement assignés. -->
        <FormField>
            <label>
                <input
                    type="checkbox"
                    :checked="canClaim"
                    @change="canClaim = ($event.target as HTMLInputElement).checked"
                />
                can claim (when off, this consumer is <strong>assignment-only</strong>: <code>ticket_engage</code> skips the global pool and returns only tickets explicitly assigned via <code>ticket_assign</code>)
            </label>
        </FormField>

        <!-- #516 (david `r59bkm` plan E) — tri-state opt-in pour les
             broadcasts projet (scope=broadcast follower fan-out).
             Auto = suit can_claim (claim-able → reçoit, no_claim → ne reçoit pas) ;
             on = opt-in explicite ; off = opt-out explicite. -->
        <FormField label="project broadcasts" for="ce-notify-broadcasts">
            <select
                id="ce-notify-broadcasts"
                v-model="notifyBroadcasts"
                class="consumer-edit__select"
            >
                <option value="auto">auto (follows can-claim)</option>
                <option value="on">on (always receive broadcasts)</option>
                <option value="off">off (never receive broadcasts)</option>
            </select>
            <small class="consumer-edit__hint">
                Receive <code>scope: broadcast</code> events (e.g. project-wide
                fan-out). <strong>Auto</strong> = same as <code>can claim</code> ;
                a no-claim consumer is silenced by default. Override to <strong>on</strong>
                if you want a no-claim agent to still see broadcasts.
            </small>
        </FormField>

        <!-- #451: raw-prompt injection (moderator-only, server-enforced). -->
        <FormField label="send a raw prompt" for="ce-prompt">
            <Textarea
                id="ce-prompt"
                v-model="promptText"
                rows="4"
                :placeholder="original.present
                    ? 'Type a prompt — injected verbatim into the live Claude session…'
                    : 'Loop offline — the prompt will be spooled and delivered when it reconnects.'"
                style="width: 100%"
                :disabled="promptBusy"
                @keydown.ctrl.enter="sendPrompt"
            />
            <small class="consumer-edit__hint">
                Sent <strong>verbatim</strong> — no moderation, no wake-phrase.
                {{ original.present
                    ? "Loop is live → delivered now."
                    : "Loop is offline → spooled until it reconnects." }}
                Ctrl+Enter to send.
            </small>
            <div class="consumer-edit__actions">
                <Button
                    label="Send prompt"
                    icon="pi pi-send"
                    size="small"
                    severity="secondary"
                    :loading="promptBusy"
                    :disabled="!promptText.trim()"
                    @click="sendPrompt"
                />
            </div>
        </FormField>

        <div class="consumer-edit__actions">
            <Button
                label="Cancel"
                text
                size="small"
                :disabled="saving"
                @click="emit('close')"
            />
            <Button
                label="Save"
                icon="pi pi-save"
                size="small"
                :loading="saving"
                @click="save"
            />
        </div>
    </div>
</template>

<style>
/* Non-scoped, same convention as ConsumerEditPage. Only the rules whose
   markup lives EXCLUSIVELY in this panel moved here ; shared classes
   (`consumer-edit__tab`, `consumer-edit__actions`) stay in the parent. */
.consumer-edit__hint {
    font-size: var(--fs-sm);
    line-height: 1.35;
    color: var(--p-text-muted-color);
}
.consumer-edit__hint code {
    font-family: var(--font-mono);
    font-size: 0.74rem;
}
</style>
