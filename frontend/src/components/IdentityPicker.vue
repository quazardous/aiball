<script setup lang="ts">
/**
 * Identity picker (#B.79). The UI defaults to the moderator persona
 * `human`, but the human user can endorse any registered consumer to
 * see the BAL through that agent's eyes (their unread state, their
 * `_status`, their inbox sort). A separate `peek` toggle disables every
 * mark-read side effect so reads don't pollute the endorsed agent's
 * seen-state.
 *
 * Autocomplete: when the popover opens we fetch /api/consumers once
 * and filter client-side. Each suggestion shows the kind badge and the
 * optional display_name so the user can tell humans from agents at a
 * glance.
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
import AutoComplete, { type AutoCompleteCompleteEvent, type AutoCompleteOptionSelectEvent } from "primevue/autocomplete";
import Button from "primevue/button";
import Popover from "primevue/popover";
import Tag from "primevue/tag";
import { api, clearAuthToken, type Consumer } from "../lib/api";
import { bus } from "../lib/bus";

// Fallback when no one is authenticated yet (pre-#B.94 state, or DB
// freshly wiped). Live UIs will have `aiball.me` set by Setup/Login.
const FALLBACK_ID = "human";

function readMe(): string {
    return localStorage.getItem("aiball.me") || FALLBACK_ID;
}
function readId(): string {
    return localStorage.getItem("aiball.human_id") || readMe();
}
function readPeek(): boolean {
    return localStorage.getItem("aiball.peek") === "1";
}

// The authenticated consumer (login). Stays stable for the session;
// the "reset" action returns here. Re-read on popover open in case
// another tab logged in/out.
const meId = ref<string>(readMe());
const consumerId = ref<string>(readId());
const peekMode = ref<boolean>(readPeek());
const draftId = ref<string>(consumerId.value);

const popoverRef = ref<InstanceType<typeof Popover> | null>(null);

// Loaded once when the popover opens, then filtered client-side via
// AutoComplete's @complete event. Re-fetched each open so a new
// consumer added between sessions surfaces.
const consumers = ref<Consumer[]>([]);
const suggestions = ref<Consumer[]>([]);
const loadingConsumers = ref(false);

async function loadConsumers(): Promise<void> {
    loadingConsumers.value = true;
    try {
        consumers.value = await api.listConsumers();
    } catch {
        consumers.value = [];
    } finally {
        loadingConsumers.value = false;
    }
}

function filterConsumers(q: string): Consumer[] {
    const needle = q.trim().toLowerCase();
    if (!needle) {
        // Empty query → suggest humans first, then everyone else.
        return [...consumers.value].sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === "human" ? -1 : 1;
            return a.consumer_id.localeCompare(b.consumer_id);
        });
    }
    return consumers.value.filter(
        (c) =>
            c.consumer_id.toLowerCase().includes(needle) ||
            (c.display_name ?? "").toLowerCase().includes(needle),
    );
}

function onComplete(event: AutoCompleteCompleteEvent): void {
    suggestions.value = filterConsumers(event.query);
}

function onSelect(event: AutoCompleteOptionSelectEvent): void {
    const c = event.value as Consumer | string;
    draftId.value = typeof c === "string" ? c : c.consumer_id;
}

async function openPopover(event: MouseEvent) {
    // Refresh `aiball.me` from storage in case the user logged in/out
    // in another tab since we last opened the popover.
    meId.value = readMe();
    draftId.value = consumerId.value;
    popoverRef.value?.show(event);
    await loadConsumers();
    suggestions.value = filterConsumers("");
}

function applyId() {
    // AutoComplete may hand back either the typed string or a Consumer
    // object on free-text submit — normalize.
    const raw = draftId.value as unknown;
    const next = (typeof raw === "string" ? raw : (raw as Consumer)?.consumer_id ?? meId.value).trim() || meId.value;
    if (next === consumerId.value) return;
    consumerId.value = next;
}

function resetToMe() {
    draftId.value = meId.value;
    consumerId.value = meId.value;
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

watch(consumerId, (v) => {
    // Persist only when peeking away from the authed identity — the
    // default (consumerId === meId) means "no override", so we clear
    // the key. Avoids stale "human" leftovers from the pre-#B.94 days.
    if (v && v !== meId.value) localStorage.setItem("aiball.human_id", v);
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
    const c = consumers.value.find((x) => x.consumer_id === consumerId.value);
    const label = c?.display_name ?? consumerId.value;
    if (peekMode.value) return `${label} · peek`;
    return label;
});

const buttonSeverity = computed(() => {
    if (peekMode.value) return "warn" as const;
    // "Acting as someone other than me" → info tint.
    if (consumerId.value !== meId.value) return "info" as const;
    return "secondary" as const;
});

const currentDraftString = computed(() => {
    const raw = draftId.value as unknown;
    return (typeof raw === "string" ? raw : (raw as Consumer)?.consumer_id ?? "").trim();
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
                <AutoComplete
                    v-model="draftId"
                    :suggestions="suggestions"
                    :loading="loadingConsumers"
                    optionLabel="consumer_id"
                    placeholder="human"
                    size="small"
                    dropdown
                    :complete-on-focus="true"
                    @complete="onComplete"
                    @option-select="onSelect"
                    @keydown.enter.prevent="applyId"
                >
                    <template #option="slotProps">
                        <div class="identity-picker__option">
                            <span class="identity-picker__cid">{{ slotProps.option.consumer_id }}</span>
                            <Tag
                                v-if="slotProps.option.kind === 'human'"
                                value="human"
                                severity="success"
                                style="font-size: 0.65rem"
                            />
                            <Tag
                                v-else
                                value="agent"
                                severity="secondary"
                                style="font-size: 0.65rem"
                            />
                            <span
                                v-if="slotProps.option.display_name"
                                class="identity-picker__display"
                            >· {{ slotProps.option.display_name }}</span>
                            <span
                                v-if="!slotProps.option.enabled"
                                class="identity-picker__display identity-picker__display--blocked"
                            >· blocked</span>
                        </div>
                    </template>
                </AutoComplete>
            </div>
            <div class="identity-picker__actions">
                <Button
                    :label="`Reset to ${meId}`"
                    icon="pi pi-replay"
                    size="small"
                    severity="secondary"
                    text
                    :disabled="draftId === meId && consumerId === meId"
                    @click="resetToMe"
                />
                <Button
                    label="Apply"
                    icon="pi pi-check"
                    size="small"
                    severity="success"
                    :disabled="currentDraftString === consumerId || !currentDraftString"
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
                Suggestions come from <strong>Settings &rsaquo; Consumers</strong>.
                Pick any registered consumer to view aiball through their eyes
                (sent as <code>X-Aiball-Consumer</code> on every call).
            </p>
            <div class="identity-picker__divider" />
            <div class="identity-picker__actions">
                <Button
                    label="Log out"
                    icon="pi pi-sign-out"
                    size="small"
                    severity="danger"
                    text
                    @click="doLogout"
                />
            </div>
        </div>
    </Popover>
</template>

<style>
.identity-picker {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    min-width: 24rem;
    max-width: 30rem;
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
.identity-picker__field :deep(.p-autocomplete),
.identity-picker__field :deep(.p-autocomplete-input) {
    width: 100%;
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
.identity-picker__option {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
}
.identity-picker__cid {
    font-family: ui-monospace, SFMono-Regular, monospace;
}
.identity-picker__display {
    color: var(--p-text-muted-color);
    font-size: 0.78rem;
}
.identity-picker__display--blocked {
    color: var(--p-red-500);
    font-style: italic;
}
</style>
