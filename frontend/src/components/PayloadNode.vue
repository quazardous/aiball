<script setup lang="ts">
/**
 * #2112 — one node of the payload's JSON tree, rendered recursively.
 *
 * Hand-rolled rather than PrimeVue's `Tree`, which would want the JSON
 * converted into `TreeNode[]` first and gives less control over how a leaf
 * prints — and the leaf is the whole point here, since a secret one must never
 * look like it is merely long. Same recursive-dispatcher shape as
 * `automation/ConditionNode.vue`.
 *
 * What this component can and cannot show is decided upstream: it renders the
 * FILTERED projection, where a secret has already been replaced by
 * `{secret: true, preview}` server-side. There is no branch here that could
 * print a secret, because none ever arrives.
 */
import { computed, ref } from "vue";

const props = defineProps<{
    /** The key this value sits under, or the index inside an array. */
    label: string;
    value: unknown;
    /** Nesting level, used to decide what starts open. */
    depth: number;
}>();

/** The redaction shape the server substitutes for a secret value. */
function isRedacted(v: unknown): v is { secret: true; preview: string | null } {
    return typeof v === "object" && v !== null && (v as { secret?: unknown }).secret === true;
}

const redacted = computed(() => (isRedacted(props.value) ? props.value : null));

const container = computed<"object" | "array" | null>(() => {
    if (redacted.value) return null; // a redacted subtree is a leaf, whatever it was
    if (Array.isArray(props.value)) return "array";
    if (props.value !== null && typeof props.value === "object") return "object";
    return null;
});

/** Children as [label, value] pairs, in insertion order. */
const entries = computed<[string, unknown][]>(() => {
    if (container.value === "array") {
        return (props.value as unknown[]).map((v, i) => [String(i), v]);
    }
    if (container.value === "object") {
        return Object.entries(props.value as Record<string, unknown>);
    }
    return [];
});

// Payloads are small by construction, so the first two levels start open —
// a tree you have to unfold before seeing anything is a worse default than a
// tree you occasionally fold. Deeper levels start closed so a big blob of
// nested config doesn't push the thread down the page.
const open = ref(props.depth < 2);

/** How many children, for the collapsed summary. */
const summary = computed(() => {
    const n = entries.value.length;
    if (container.value === "array") return `[${n}]`;
    return `{${n}}`;
});

const leafClass = computed(() => {
    if (redacted.value) return "payload-node__value--secret";
    if (props.value === null) return "payload-node__value--null";
    if (typeof props.value === "number") return "payload-node__value--number";
    if (typeof props.value === "boolean") return "payload-node__value--bool";
    return "payload-node__value--string";
});

const leafText = computed(() => {
    if (props.value === null) return "null";
    if (typeof props.value === "string") return props.value;
    return JSON.stringify(props.value);
});
</script>

<template>
    <div class="payload-node">
        <!-- Container: a disclosure row, then the children. -->
        <template v-if="container">
            <button type="button" class="payload-node__row payload-node__row--toggle" @click="open = !open">
                <i :class="open ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" class="payload-node__caret" />
                <span class="payload-node__key">{{ label }}</span>
                <span class="payload-node__count">{{ summary }}</span>
            </button>
            <div v-if="open" class="payload-node__children">
                <PayloadNode
                    v-for="[childLabel, childValue] in entries"
                    :key="childLabel"
                    :label="childLabel"
                    :value="childValue"
                    :depth="depth + 1"
                />
            </div>
        </template>

        <!-- Leaf. A secret prints its prefix and nothing else; when the value
             was too short for a prefix, it prints no characters at all. -->
        <div v-else class="payload-node__row">
            <span class="payload-node__key">{{ label }}</span>
            <span v-if="redacted" class="payload-node__value payload-node__value--secret">
                <i class="pi pi-lock payload-node__lock" />
                <template v-if="redacted.preview">{{ redacted.preview }}…</template>
                <template v-else>secret</template>
            </span>
            <span v-else class="payload-node__value" :class="leafClass">{{ leafText }}</span>
        </div>
    </div>
</template>

<style>
.payload-node__row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.1rem 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.82rem;
    line-height: 1.5;
}
/* The toggle is a button for keyboard reach; strip the button chrome so the
   tree reads as data rather than as a row of controls. */
.payload-node__row--toggle {
    background: none;
    border: none;
    width: 100%;
    text-align: left;
    cursor: pointer;
    color: inherit;
}
.payload-node__caret {
    font-size: 0.65rem;
    opacity: 0.55;
}
.payload-node__key {
    color: var(--p-text-muted-color, #6b7280);
}
.payload-node__key::after {
    content: ":";
    opacity: 0.5;
}
.payload-node__count {
    opacity: 0.45;
    font-size: 0.75rem;
}
.payload-node__children {
    margin-left: 0.85rem;
    padding-left: 0.5rem;
    border-left: 1px solid var(--p-content-border-color, #e5e7eb);
}
.payload-node__value {
    word-break: break-all;
}
.payload-node__value--string { color: var(--p-primary-color, #3b82f6); }
.payload-node__value--number { color: #b45309; }
.payload-node__value--bool { color: #7c3aed; }
.payload-node__value--null { opacity: 0.5; font-style: italic; }
/* A secret must not read as "a short string". The lock plus the muted,
   dashed frame says the value is withheld, not that it is brief. */
.payload-node__value--secret {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0 0.35rem;
    border: 1px dashed var(--p-content-border-color, #d1d5db);
    border-radius: 3px;
    color: var(--p-text-muted-color, #6b7280);
    background: var(--p-content-hover-background, rgba(127, 127, 127, 0.07));
}
.payload-node__lock {
    font-size: 0.65rem;
    opacity: 0.7;
}
</style>
