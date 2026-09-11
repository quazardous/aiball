<script setup lang="ts">
/**
 * #1832 — the per-project standing instruction, one click from anywhere.
 *
 * It already lived on the project settings page, which is the right home for a
 * setting but the wrong place for this one: it is typed at the moment of
 * leaving, and walking into settings to type one sentence is enough friction
 * to skip it. So it also sits beside the go-to field, next to the other things
 * you reach for without thinking.
 *
 * The icon carries the state. Coloured means an instruction is live and every
 * wake on this project starts with it — worth seeing without opening anything,
 * because a stale instruction left behind after coming back is the failure
 * mode here, not a missing one.
 *
 * Always rendered, disabled when no project is in scope. The first version
 * hid it in that case — "a button that can never do anything is noise" — and
 * that was wrong the moment david went looking for it and found nothing.
 * Invisible is worse than disabled when someone is hunting for a control: a
 * greyed icon with a reason teaches where it lives, an absent one reads as
 * "not shipped".
 *
 * #2333 — the same popover carries a message to every agent loop, below the
 * instruction (david: reuse this form rather than add a button). "send" types it
 * into each running session now; "send & hold" also holds every loop
 * indefinitely (NOT AFK ∞) before leaving; "release holds" lifts them on return.
 * That part is not per project, so the button now opens without a project and
 * only the instruction waits for one.
 */
import { computed, ref, watch } from "vue";
import Button from "primevue/button";
import Popover from "primevue/popover";
import Textarea from "primevue/textarea";
import { api, type Consumer, type LoopHoldResult } from "../lib/api";
import { readStandingPromptHistory, rememberStandingPrompt } from "../lib/standing-prompt";

const props = defineProps<{ project: string | null }>();

const popoverRef = ref<InstanceType<typeof Popover> | null>(null);
const value = ref("");
const saved = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const history = ref<string[]>([]);

async function refresh(): Promise<void> {
    if (!props.project) return;
    try {
        const r = await api.getProjectStandingPrompt(props.project);
        saved.value = r.standing_prompt ?? "";
        value.value = saved.value;
        error.value = null;
    } catch (e) {
        error.value = (e as Error).message;
    }
}

// Kept fresh without opening the popover: the icon's colour is the whole point,
// so it has to be right before the first click, and after switching project.
watch(() => props.project, () => { saved.value = ""; value.value = ""; void refresh(); }, { immediate: true });

function open(event: MouseEvent): void {
    if (props.project) {
        history.value = readStandingPromptHistory(props.project);
        void refresh();
    }
    loopResults.value = null;
    void refreshLoops();
    popoverRef.value?.show(event);
}

async function save(): Promise<void> {
    if (!props.project) return;
    const next = value.value.trim();
    if (next === saved.value) { popoverRef.value?.hide(); return; }
    busy.value = true;
    try {
        const r = await api.setProjectStandingPrompt(props.project, next || null);
        saved.value = r.standing_prompt ?? "";
        value.value = saved.value;
        history.value = rememberStandingPrompt(props.project, saved.value);
        popoverRef.value?.hide();
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        busy.value = false;
    }
}

/** Clearing is a first-class gesture, not an afterthought: the instruction is
 *  posted on leaving and has to be dropped on return, and a stale one is worse
 *  than none. It never touches the history. */
async function clear(): Promise<void> {
    value.value = "";
    await save();
}

// #2333 — the message to every agent loop.
const DEFAULT_LOOP_MESSAGE = "Priority message from the operator: I am disconnecting. Stabilise now: finish or park "
    + "your current step, leave nothing half-done (commit what is green, revert what is not), post the ticket state "
    + "(then: continue or handback), then stop. Your loop is held until I am back.";
const loopMessage = ref(DEFAULT_LOOP_MESSAGE);
const liveLoops = ref<Consumer[]>([]);
const loopBusy = ref(false);
const loopError = ref<string | null>(null);
const loopResults = ref<LoopHoldResult[] | null>(null);
const loopNames = computed(() => liveLoops.value.map((c) => c.consumer_id).join(", "));
const canSendLoops = computed(() => !loopBusy.value && liveLoops.value.length > 0 && loopMessage.value.trim().length > 0);

async function refreshLoops(): Promise<void> {
    try {
        const all = await api.listConsumers();
        liveLoops.value = all
            .filter((c) => c.kind !== "human" && c.present === true)
            .sort((a, b) => a.consumer_id.localeCompare(b.consumer_id));
        loopError.value = null;
    } catch (e) {
        loopError.value = (e as Error).message;
    }
}

async function runLoopControl(call: () => Promise<{ results: LoopHoldResult[] }>): Promise<void> {
    loopBusy.value = true;
    try {
        loopResults.value = (await call()).results;
        loopError.value = null;
    } catch (e) {
        loopError.value = (e as Error).message;
    } finally {
        loopBusy.value = false;
    }
}

function messageAll(hold: boolean): Promise<void> {
    return runLoopControl(() => api.messageAllLoops(loopMessage.value.trim(), hold));
}

function releaseAll(): Promise<void> {
    return runLoopControl(() => api.releaseAllLoops());
}

function describeLoopResult(r: LoopHoldResult): string {
    const parts: string[] = [];
    if (r.prompt) parts.push(r.prompt === "delivered" ? "message delivered" : "message queued until the loop reconnects");
    if (r.hold === "armed") parts.push("held ∞");
    else if (r.hold === "released") parts.push("released");
    else if (r.hold === "failed") parts.push(`hold not applied: ${r.hold_error ?? "unknown reason"}`);
    return parts.join(" · ");
}
</script>

<template>
        <Button
            icon="pi pi-megaphone"
            severity="secondary"
            size="small"
            text
            rounded
            class="standing-prompt-btn"
            :class="{ 'standing-prompt-btn--set': !!saved }"
            :aria-label="!project
                ? 'Message every agent (a standing instruction needs a project)'
                : saved
                    ? `Standing instruction active on ${project} — click to edit`
                    : `Set a standing instruction for ${project}`"
            :title="!project
                ? 'Message every agent loop. The standing instruction is per project: pick one to set it.'
                : saved
                    ? `Every wake on ${project} starts with: “${saved}”`
                    : `No standing instruction on ${project}. Wakes read as usual.`"
            @click="open"
        />
        <Popover ref="popoverRef">
            <div class="standing-prompt-pop">
                <div class="standing-prompt-pop__head">
                    Standing instruction — <strong v-if="project">{{ project }}</strong><span v-else>pick a project first</span>
                </div>
                <p class="standing-prompt-pop__hint">
                    Prepended to every wake, event and backlog alike. Leave one
                    before stepping away; clear it when you are back.
                </p>
                <input
                    v-model="value"
                    list="standing-prompt-pop-history"
                    type="text"
                    class="standing-prompt-pop__input"
                    placeholder="e.g. priorité au debug léger, pas de grosse évolution"
                    :disabled="busy || !project"
                    @keyup.enter="save"
                >
                <datalist id="standing-prompt-pop-history">
                    <option v-for="h in history" :key="h" :value="h" />
                </datalist>
                <div v-if="error" class="standing-prompt-pop__error">{{ error }}</div>
                <div class="standing-prompt-pop__actions">
                    <Button
                        label="clear"
                        severity="secondary"
                        size="small"
                        text
                        :disabled="busy || !saved"
                        @click="clear"
                    />
                    <Button label="save" size="small" :loading="busy" :disabled="!project" @click="save" />
                </div>
                <!-- #2333 — the message to every agent loop running on this aiball. -->
                <div class="loop-message">
                    <div class="standing-prompt-pop__head">Message to every agent</div>
                    <p class="standing-prompt-pop__hint">
                        Typed into each running agent session now, whatever it is doing.
                        <strong>send &amp; hold</strong> also holds every loop (NOT AFK ∞): no
                        auto-wake starts new work until you release them.
                    </p>
                    <div class="loop-message__loops">
                        <template v-if="liveLoops.length">{{ liveLoops.length }} running: {{ loopNames }}</template>
                        <template v-else>No agent loop is running.</template>
                    </div>
                    <Textarea
                        v-model="loopMessage"
                        rows="4"
                        auto-resize
                        class="loop-message__text"
                        :disabled="loopBusy"
                    />
                    <div v-if="loopError" class="standing-prompt-pop__error">{{ loopError }}</div>
                    <ul v-if="loopResults" class="loop-message__results">
                        <li v-for="r in loopResults" :key="r.consumer_id">
                            <strong>{{ r.consumer_id }}</strong> — {{ describeLoopResult(r) }}
                        </li>
                        <li v-if="loopResults.length === 0">No agent loop was running.</li>
                    </ul>
                    <div class="standing-prompt-pop__actions">
                        <Button
                            label="release holds"
                            severity="secondary"
                            size="small"
                            text
                            :disabled="loopBusy || !liveLoops.length"
                            @click="releaseAll"
                        />
                        <Button label="send" severity="secondary" size="small" :disabled="!canSendLoops" @click="messageAll(false)" />
                        <Button label="send &amp; hold" severity="danger" size="small" :loading="loopBusy" :disabled="!canSendLoops" @click="messageAll(true)" />
                    </div>
                </div>
            </div>
    </Popover>
</template>

<style scoped>
/* The colour IS the signal — an instruction left behind is the thing worth
   noticing from across the header. */
.standing-prompt-btn--set :deep(.pi) {
    color: var(--p-green-500);
}
.standing-prompt-pop {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 26rem;
    max-width: 32rem;
}
.standing-prompt-pop__head {
    font-size: var(--fs-sm, 0.85rem);
}
.standing-prompt-pop__hint {
    margin: 0;
    font-size: var(--fs-sm, 0.85rem);
    color: var(--p-text-muted-color);
}
.standing-prompt-pop__input {
    width: 100%;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--p-inputtext-border-color, var(--p-surface-300));
    border-radius: var(--p-border-radius, 6px);
    background: var(--p-inputtext-background, transparent);
    color: inherit;
    font: inherit;
}
.standing-prompt-pop__error {
    font-size: var(--fs-sm, 0.85rem);
    color: var(--p-red-500);
}
/* #2333 — the all-agents message sits under the instruction, set apart by a rule. */
.loop-message {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.3rem;
    padding-top: 0.6rem;
    border-top: 1px solid var(--p-content-border-color);
}
.loop-message__text {
    width: 100%;
}
.loop-message__loops,
.loop-message__results {
    font-size: var(--fs-sm, 0.85rem);
    color: var(--p-text-muted-color);
}
.loop-message__results {
    margin: 0;
    padding-left: 1.1rem;
}
.standing-prompt-pop__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.4rem;
}
</style>
