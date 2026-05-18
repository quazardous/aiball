<script setup lang="ts">
import { ref, watch } from "vue";
import { api, type Tag } from "../lib/api";
import { useBus } from "../lib/bus";
import TagBadge from "./TagBadge.vue";

const props = defineProps<{
    messageId: number;
    tags: Tag[];
    setBy?: string;
}>();
const emit = defineEmits<{ (e: "changed", tags: Tag[]): void }>();

const allTags = ref<Tag[]>([]);
const selected = ref<Set<number>>(new Set(props.tags.map((t) => t.id)));
const busy = ref(false);
const error = ref<string | null>(null);

watch(
    () => props.tags,
    (v) => {
        selected.value = new Set(v.map((t) => t.id));
    },
);

async function loadCatalog() {
    try {
        allTags.value = await api.listTags();
    } catch (e) {
        error.value = (e as Error).message;
    }
}
loadCatalog();
// Keep the picker in sync if the tag catalog is edited from elsewhere
// (TagsPanel CRUD, another agent, another browser tab).
useBus("tags.refresh", () => loadCatalog());

async function toggle(t: Tag) {
    const next = new Set(selected.value);
    if (next.has(t.id)) next.delete(t.id);
    else next.add(t.id);
    selected.value = next;
    await save();
}

async function save() {
    busy.value = true;
    try {
        const result = await api.setMessageTags(
            props.messageId,
            [...selected.value],
            props.setBy,
        );
        emit("changed", result);
        error.value = null;
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        busy.value = false;
    }
}
</script>

<template>
    <div class="tag-picker">
        <div class="tag-picker__catalog">
            <button
                v-for="t in allTags"
                :key="t.id"
                type="button"
                class="tag-picker__btn"
                :class="{ 'is-selected': selected.has(t.id) }"
                :disabled="busy"
                @click="toggle(t)"
            >
                <TagBadge :tag="t" size="sm" />
            </button>
        </div>
        <div v-if="!allTags.length" class="aiball-empty" style="padding: 0.4rem; font-size: 0.85rem">
            No tags defined yet. Open the Tags panel to add some.
        </div>
        <div v-if="error" style="color: var(--p-red-500); font-size: 0.85rem">
            <i class="pi pi-exclamation-triangle" /> {{ error }}
        </div>
    </div>
</template>

<style>
.tag-picker {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}
.tag-picker__catalog {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
}
.tag-picker__btn {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 0.1rem;
    cursor: pointer;
    opacity: 0.4;
    transition: opacity 0.15s, border-color 0.15s;
}
.tag-picker__btn:hover {
    opacity: 0.8;
}
.tag-picker__btn.is-selected {
    opacity: 1;
    border-color: var(--p-primary-color);
}
</style>
