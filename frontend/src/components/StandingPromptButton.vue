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
 * Hidden entirely when no project is selected. The instruction is per-project,
 * so on the cross-project inbox there is nothing this control could act on,
 * and a button that can never do anything is noise.
 */
import { ref, watch } from "vue";
import Button from "primevue/button";
import Popover from "primevue/popover";
import { api } from "../lib/api";
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
    if (!props.project) return;
    history.value = readStandingPromptHistory(props.project);
    void refresh();
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
</script>

<template>
    <template v-if="project">
        <Button
            icon="pi pi-megaphone"
            severity="secondary"
            size="small"
            text
            rounded
            class="standing-prompt-btn"
            :class="{ 'standing-prompt-btn--set': !!saved }"
            :aria-label="saved
                ? `Standing instruction active on ${project} — click to edit`
                : `Set a standing instruction for ${project}`"
            :title="saved
                ? `Every wake on ${project} starts with: “${saved}”`
                : `No standing instruction on ${project}. Wakes read as usual.`"
            @click="open"
        />
        <Popover ref="popoverRef">
            <div class="standing-prompt-pop">
                <div class="standing-prompt-pop__head">
                    Standing instruction — <strong>{{ project }}</strong>
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
                    :disabled="busy"
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
                    <Button label="save" size="small" :loading="busy" @click="save" />
                </div>
            </div>
        </Popover>
    </template>
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
.standing-prompt-pop__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.4rem;
}
</style>
