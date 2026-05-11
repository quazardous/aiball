<script setup lang="ts">
/**
 * Identity picker (per #B.79). The UI defaults to the moderator
 * persona `human`, but the human user can endorse any consumer_id
 * to see the BAL through that agent's eyes (their unread state,
 * their `_status`, their inbox sort). A separate `peek` toggle
 * disables every mark-read side effect so reads don't pollute the
 * endorsed agent's seen-state.
 *
 * Storage:
 *   - `aiball.human_id` — current consumer_id (default "human")
 *   - `aiball.peek`     — "1" if peek mode is on, absent otherwise
 *
 * Reactive consumers:
 *   - `lib/api.ts` reads `aiball.human_id` per request (auto).
 *   - `lib/peek.ts` exposes `isPeek()` for sites that must skip
 *     mark-read calls (auto-mark timer, manual toggleRead).
 *   - On any change here, we emit `inbox.refresh` + `projects.refresh`
 *     on the bus so the displayed perspective tracks the new identity.
 */
import { computed, ref, watch } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Popover from "primevue/popover";
import { bus } from "../lib/bus";

const DEFAULT_ID = "human";

function readId(): string {
    return localStorage.getItem("aiball.human_id") || DEFAULT_ID;
}
function readPeek(): boolean {
    return localStorage.getItem("aiball.peek") === "1";
}

const consumerId = ref<string>(readId());
const peekMode = ref<boolean>(readPeek());
const draftId = ref<string>(consumerId.value);

const popoverRef = ref<InstanceType<typeof Popover> | null>(null);

function openPopover(event: MouseEvent) {
    draftId.value = consumerId.value;
    popoverRef.value?.show(event);
}

function applyId() {
    const next = (draftId.value || DEFAULT_ID).trim();
    if (next === consumerId.value) return;
    consumerId.value = next;
}

function resetToHuman() {
    draftId.value = DEFAULT_ID;
    consumerId.value = DEFAULT_ID;
}

watch(consumerId, (v) => {
    if (v && v !== DEFAULT_ID) localStorage.setItem("aiball.human_id", v);
    else localStorage.removeItem("aiball.human_id");
    bus.emit("inbox.refresh");
    bus.emit("projects.refresh");
});

watch(peekMode, (v) => {
    if (v) localStorage.setItem("aiball.peek", "1");
    else localStorage.removeItem("aiball.peek");
    bus.emit("inbox.refresh");
    bus.emit("projects.refresh");
});

const summary = computed(() => {
    if (peekMode.value) return `${consumerId.value} · peek`;
    return consumerId.value;
});

const buttonSeverity = computed(() => {
    if (peekMode.value) return "warn" as const;
    if (consumerId.value !== DEFAULT_ID) return "info" as const;
    return "secondary" as const;
});
</script>

<template>
    <Button
        :icon="peekMode ? 'pi pi-eye-slash' : 'pi pi-user'"
        :label="summary"
        :severity="buttonSeverity"
        size="small"
        text
        :title="peekMode
            ? `Acting as ${consumerId} in peek mode — reads do not mark anything seen.`
            : `Acting as ${consumerId}. Click to change identity or enable peek mode.`"
        @click="openPopover"
    />
    <Popover ref="popoverRef">
        <div class="identity-picker">
            <div class="identity-picker__field">
                <label class="identity-picker__label">Consumer ID</label>
                <InputText
                    v-model="draftId"
                    size="small"
                    placeholder="human"
                    @keydown.enter.prevent="applyId"
                />
            </div>
            <div class="identity-picker__actions">
                <Button
                    label="Reset to human"
                    icon="pi pi-replay"
                    size="small"
                    severity="secondary"
                    text
                    @click="resetToHuman"
                />
                <Button
                    label="Apply"
                    icon="pi pi-check"
                    size="small"
                    severity="success"
                    :disabled="(draftId || DEFAULT_ID).trim() === consumerId"
                    @click="applyId"
                />
            </div>
            <div class="identity-picker__divider" />
            <label class="identity-picker__peek">
                <input type="checkbox" v-model="peekMode" />
                <div>
                    <strong>Peek mode</strong>
                    <span class="identity-picker__hint">
                        Suppresses mark-read side effects (auto-mark on thread view,
                        manual toggle). Useful when impersonating an agent for
                        debugging — your reads don't pollute their seen-state.
                    </span>
                </div>
            </label>
            <p class="identity-picker__footer">
                The selected consumer applies to every API call (sent as the
                <code>X-Aiball-Consumer</code> header) — inbox, sidebar badges,
                and unread filters reflect that agent's perspective.
            </p>
        </div>
    </Popover>
</template>

<style>
.identity-picker {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    min-width: 22rem;
    max-width: 28rem;
    padding: 0.2rem;
}
.identity-picker__field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
}
.identity-picker__label {
    font-size: 0.78rem;
    color: var(--p-text-muted-color);
}
.identity-picker__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.4rem;
}
.identity-picker__divider {
    height: 1px;
    background: var(--p-content-border-color);
    margin: 0.2rem 0;
}
.identity-picker__peek {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    cursor: pointer;
    font-size: 0.88rem;
    line-height: 1.4;
}
.identity-picker__peek input[type="checkbox"] {
    margin-top: 0.2rem;
    cursor: pointer;
}
.identity-picker__hint {
    display: block;
    color: var(--p-text-muted-color);
    font-size: 0.82rem;
    margin-top: 0.1rem;
}
.identity-picker__footer {
    margin: 0;
    color: var(--p-text-muted-color);
    font-size: 0.78rem;
    line-height: 1.45;
}
.identity-picker__footer code {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.78rem;
    padding: 0.05rem 0.3rem;
    background: var(--p-surface-100);
    border-radius: 0.2rem;
}
.aiball-dark .identity-picker__footer code {
    background: var(--p-surface-800);
}
</style>
