<script setup lang="ts">
// #449: generic config-manager UI. Renders the daemon's config schema for one
// scope — GLOBAL when no `project`, the project layer when a `project` is given
// — with the layered "use global (currently X)" / "default" semantics. Same
// component drives Settings > General (global) and Project Settings (per-project)
// so every key is editable in both places with no per-key wiring. Protected
// keys carry a lock; the API enforces moderator-only writes (a 403 surfaces).
import { computed, ref, watch } from "vue";
import Select from "primevue/select";
import InputText from "primevue/inputtext";
import Button from "primevue/button";
import { api, type ConfigPrimitive, type ManagedConfigRow } from "../lib/api";
import { useLoader } from "../lib/loader";
import AsyncState from "./ui/AsyncState.vue";

const props = defineProps<{ project?: string | null }>();

const rows = ref<ManagedConfigRow[]>([]);
const error = ref<string | null>(null);
const drafts = ref<Record<string, string>>({}); // editing buffer for number/string

const INHERIT = "__inherit__";
const isGlobalView = computed(() => !props.project);

// Global view shows keys with a global value; project view shows keys that may
// be overridden per project.
const visibleRows = computed(() => rows.value.filter((r) =>
    isGlobalView.value
        ? r.scope === "global" || r.scope === "global+project"
        : r.scope === "global+project" || r.scope === "project",
));

function layerValue(r: ManagedConfigRow): ConfigPrimitive | null {
    return isGlobalView.value ? r.global : r.project;
}
function inheritedValue(r: ManagedConfigRow): ConfigPrimitive {
    return isGlobalView.value ? r.default : (r.global ?? r.default);
}
function hasOverride(r: ManagedConfigRow): boolean {
    return layerValue(r) !== null;
}
function inheritLabel(r: ManagedConfigRow): string {
    return isGlobalView.value
        ? `Default (${r.default})`
        : `Use global (currently: ${inheritedValue(r)})`;
}
function selectModel(r: ManagedConfigRow): ConfigPrimitive | string {
    const v = layerValue(r);
    return v === null ? INHERIT : v;
}
function selectOptions(r: ManagedConfigRow): { label: string; value: ConfigPrimitive | string }[] {
    const opts: { label: string; value: ConfigPrimitive | string }[] = [
        { label: inheritLabel(r), value: INHERIT },
    ];
    if (r.type === "boolean") {
        opts.push({ label: "On", value: true }, { label: "Off", value: false });
    } else if (r.type === "enum" && r.options) {
        for (const o of r.options) opts.push({ label: o, value: o });
    }
    return opts;
}

const { loading, load } = useLoader(async () => {
    const r = await api.listManagedConfig(props.project ?? null);
    rows.value = r.config;
    const d: Record<string, string> = {};
    for (const row of r.config) {
        const lv = isGlobalView.value ? row.global : row.project;
        d[row.key] = lv === null || lv === undefined ? "" : String(lv);
    }
    drafts.value = d;
}, { error, mountLoad: true });

async function applyValue(r: ManagedConfigRow, value: ConfigPrimitive) {
    error.value = null;
    try {
        await api.setManagedConfig(r.key, value, props.project ?? null);
        await load();
    } catch (e) {
        error.value = (e as Error).message;
    }
}
async function clearValue(r: ManagedConfigRow) {
    error.value = null;
    try {
        await api.clearManagedConfig(r.key, props.project ?? null);
        await load();
    } catch (e) {
        error.value = (e as Error).message;
    }
}
function onSelect(r: ManagedConfigRow, v: ConfigPrimitive | string) {
    if (v === INHERIT) { void clearValue(r); return; }
    void applyValue(r, v as ConfigPrimitive);
}
function saveText(r: ManagedConfigRow) {
    const raw = (drafts.value[r.key] ?? "").trim();
    if (raw === "") { void clearValue(r); return; }
    void applyValue(r, r.type === "number" ? Number(raw) : raw);
}

watch(() => props.project, () => load());
</script>

<template>
    <div class="managed-config">
        <AsyncState :loading="loading" :empty="!visibleRows.length">
            <template #empty>
                No configurable keys {{ isGlobalView ? "yet" : "for a project" }}.
            </template>
            <div class="managed-config__list">
                <div v-for="r in visibleRows" :key="r.key" class="managed-config__row">
                    <div class="managed-config__head">
                        <span class="managed-config__label">{{ r.label }}</span>
                        <i
                            v-if="r.protected"
                            class="pi pi-lock managed-config__lock"
                            title="Protected — moderator only"
                        />
                        <code class="managed-config__key">{{ r.key }}</code>
                    </div>
                    <p class="managed-config__desc">{{ r.description }}</p>
                    <div class="managed-config__control">
                        <Select
                            v-if="r.type === 'enum' || r.type === 'boolean'"
                            :model-value="selectModel(r)"
                            :options="selectOptions(r)"
                            option-label="label"
                            option-value="value"
                            class="managed-config__select"
                            @update:model-value="(v: ConfigPrimitive | string) => onSelect(r, v)"
                        />
                        <template v-else>
                            <InputText
                                v-model="drafts[r.key]"
                                :placeholder="String(inheritedValue(r))"
                                class="managed-config__input"
                                @keyup.enter="saveText(r)"
                            />
                            <Button label="Save" size="small" @click="saveText(r)" />
                            <Button
                                v-if="hasOverride(r)"
                                label="Reset"
                                size="small"
                                severity="secondary"
                                text
                                @click="clearValue(r)"
                            />
                        </template>
                    </div>
                    <div class="managed-config__state">
                        effective: <strong>{{ String(r.value) }}</strong>
                        <template v-if="hasOverride(r)">
                            — overrides {{ isGlobalView ? `default (${r.default})` : `global (${inheritedValue(r)})` }}
                        </template>
                        <template v-else>
                            — {{ isGlobalView ? "using default" : `follows global (${inheritedValue(r)})` }}
                        </template>
                    </div>
                </div>
            </div>
        </AsyncState>
        <div v-if="error" class="managed-config__error">
            <i class="pi pi-exclamation-triangle" /> {{ error }}
        </div>
    </div>
</template>

<style scoped>
.managed-config__list {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
}
.managed-config__row {
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.45rem;
    padding: 0.6rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
}
.managed-config__head {
    display: flex;
    align-items: center;
    gap: 0.45rem;
}
.managed-config__label {
    font-weight: 600;
    font-size: 0.92rem;
}
.managed-config__lock {
    font-size: var(--fs-sm);
    color: var(--p-text-muted-color);
}
.managed-config__key {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 0.74rem;
    color: var(--p-text-muted-color);
}
.managed-config__desc {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--p-text-muted-color);
    line-height: 1.4;
}
.managed-config__control {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
}
.managed-config__select {
    min-width: 16rem;
}
.managed-config__input {
    min-width: 12rem;
}
.managed-config__state {
    font-size: var(--fs-sm);
    color: var(--p-text-muted-color);
}
.managed-config__error {
    margin-top: 0.6rem;
    color: var(--p-red-500);
    background: color-mix(in srgb, var(--p-red-500) 10%, transparent);
    padding: 0.5rem 0.7rem;
    border-radius: var(--radius-md);
    font-size: var(--fs-md);
}
</style>
