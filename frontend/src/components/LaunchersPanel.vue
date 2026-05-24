<script setup lang="ts">
// #398: operator-approved command launchers. Lists the launchers declared in
// the global config `launchers:` block (GET /api/launchers) and runs one on
// click (POST /api/launchers/:id/run — human-only, detached spawn on the host).
import { onMounted, ref } from "vue";
import Button from "primevue/button";
import { api, type Launcher } from "../lib/api";

const launchers = ref<Launcher[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const flash = ref<string | null>(null);
const running = ref<string | null>(null);

async function load() {
    loading.value = true;
    error.value = null;
    try {
        launchers.value = await api.listLaunchers();
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        loading.value = false;
    }
}

async function run(l: Launcher) {
    running.value = l.id;
    flash.value = null;
    try {
        const r = await api.runLauncher(l.id);
        flash.value = `Launched ${r.label} (pid ${r.pid})`;
    } catch (e) {
        flash.value = `Failed: ${(e as Error).message}`;
    } finally {
        running.value = null;
    }
}

onMounted(load);
</script>

<template>
    <div class="launchers-panel">
        <header class="launchers-panel__head">
            <h2>Launchers</h2>
            <button type="button" class="launchers-panel__refresh" title="Refresh" @click="load">
                <i class="pi pi-refresh" />
            </button>
        </header>
        <p class="launchers-panel__hint">
            Operator-approved commands, declared in the global config
            <code>launchers:</code> block. Human-only.
        </p>
        <p v-if="flash" class="launchers-panel__flash">{{ flash }}</p>

        <div v-if="loading" class="aiball-empty">Loading…</div>
        <div v-else-if="error" class="aiball-empty" style="color: var(--p-red-500)">{{ error }}</div>
        <div v-else-if="launchers.length === 0" class="aiball-empty">
            No launchers configured. Add a <code>launchers:</code> list to
            <code>~/.config/aiball/config.yaml</code> — each entry needs an
            <code>id</code>, <code>label</code> and <code>cmd</code> (optional
            <code>args</code>, <code>cwd</code>, <code>icon</code>).
        </div>
        <ul v-else class="launchers-panel__list">
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
    </div>
</template>

<style scoped>
.launchers-panel { display: flex; flex-direction: column; gap: 0.8rem; }
.launchers-panel__head { display: flex; align-items: center; gap: 0.6rem; }
.launchers-panel__head h2 { margin: 0; font-size: 1.3rem; }
.launchers-panel__refresh { background: none; border: none; cursor: pointer; color: var(--p-text-color); }
.launchers-panel__hint { margin: 0; font-size: 0.85rem; color: var(--p-text-muted-color, #6b7280); }
.launchers-panel__flash { margin: 0; font-size: 0.85rem; color: var(--p-green-600, #16a34a); }
.launchers-panel__list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.launchers-panel__item { display: flex; align-items: center; gap: 0.6rem; }
.launchers-panel__cmd { font-size: 0.75rem; color: var(--p-text-muted-color, #6b7280); }
</style>
