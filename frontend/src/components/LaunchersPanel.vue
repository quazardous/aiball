<script setup lang="ts">
// #398: operator-approved command launchers. Lists the launchers declared in
// the global config `launchers:` block (GET /api/launchers) and runs one on
// click (POST /api/launchers/:id/run — human-only, detached spawn on the host).
import { ref } from "vue";
import Button from "primevue/button";
import { api, type Launcher } from "../lib/api";
import { useLoader } from "../lib/loader";
import { useNotify } from "../lib/notify";
import PanelHeader from "./ui/PanelHeader.vue";
import AsyncState from "./ui/AsyncState.vue";

const launchers = ref<Launcher[]>([]);
const running = ref<string | null>(null);

const notify = useNotify();

const { loading, error, load } = useLoader(async () => {
    launchers.value = await api.listLaunchers();
}, { mountLoad: true });

async function run(l: Launcher) {
    running.value = l.id;
    try {
        const r = await api.runLauncher(l.id);
        // #459 — était un `flash` ref local + <p> bespoke, identique à
        // ProjectDetailPage.launch (même anti-pattern). Migré vers le toast
        // général via useNotify.
        notify.success(`Launched ${r.label}`, { detail: `pid ${r.pid}` });
    } catch (e) {
        notify.error(`Launcher "${l.label}" failed`, { detail: (e as Error).message });
    } finally {
        running.value = null;
    }
}
</script>

<template>
    <div class="launchers-panel">
        <PanelHeader title="Launchers">
            <template #actions>
                <button type="button" class="launchers-panel__refresh" title="Refresh" @click="load">
                    <i class="pi pi-refresh" />
                </button>
            </template>
            <p class="aiball-explainer aiball-explainer--muted">
                Operator-approved commands, declared in the global config
                <code>launchers:</code> block. Human-only.
            </p>
        </PanelHeader>

        <AsyncState :loading="loading" :error="error" :empty="launchers.length === 0">
            <template #empty>
                No launchers configured. Add a <code>launchers:</code> list to
                <code>~/.config/aiball/config.yaml</code> — each entry needs an
                <code>id</code>, <code>label</code> and <code>cmd</code> (optional
                <code>args</code>, <code>cwd</code>, <code>icon</code>).
            </template>
        <ul class="launchers-panel__list">
            <li v-for="l in launchers" :key="l.id" class="launchers-panel__item">
                <Button
                    :label="l.label"
                    :icon="l.icon ? `pi ${l.icon}` : 'pi pi-play'"
                    :loading="running === l.id"
                    size="small"
                    @click="run(l)"
                />
                <code class="launchers-panel__cmd">{{ l.cmd }}{{ l.args && l.args.length ? " " + l.args.join(" ") : "" }}</code>
            </li>
        </ul>
        </AsyncState>
    </div>
</template>

<style scoped>
.launchers-panel { display: flex; flex-direction: column; gap: 0.8rem; }
/* En-tête → <PanelHeader> (style.css). */
.launchers-panel__refresh { background: none; border: none; cursor: pointer; color: var(--p-text-color); }
/* #459 : flash retiré, les feedbacks vont via `useNotify()` (lib/notify.ts). */
.launchers-panel__list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.launchers-panel__item { display: flex; align-items: center; gap: 0.6rem; }
.launchers-panel__cmd { font-size: var(--fs-xs); color: var(--p-text-muted-color, #6b7280); }
</style>
