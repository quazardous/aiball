<script setup lang="ts">
import { useSlots } from "vue";

defineProps<{
    selected?: boolean;
    unread?: boolean;
    pending?: boolean;
    closed?: boolean;
    danger?: boolean;
}>();
const emit = defineEmits<{
    (e: "click", ev: MouseEvent): void;
}>();

const slots = useSlots();
</script>

<template>
    <div
        class="list-row"
        :class="{
            'list-row--selected': selected,
            'list-row--unread': unread,
            'list-row--pending': pending,
            'list-row--closed': closed,
            'list-row--danger': danger,
        }"
        @click="emit('click', $event)"
    >
        <div class="list-row__lead" @click.stop>
            <slot name="select" />
            <slot name="lead" />
        </div>
        <div v-if="slots.from" class="list-row__from">
            <slot name="from" />
        </div>
        <div class="list-row__main">
            <span class="list-row__title"><slot name="title" /></span>
            <span v-if="slots.snippet" class="list-row__snippet">
                <slot name="snippet" />
            </span>
        </div>
        <div class="list-row__tail">
            <span v-if="slots.meta" class="list-row__meta"><slot name="meta" /></span>
            <span v-if="slots.time" class="list-row__time"><slot name="time" /></span>
            <div v-if="slots.actions" class="list-row__actions" @click.stop>
                <slot name="actions" />
            </div>
        </div>
    </div>
</template>

<style>
.list-row {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    gap: 0.7rem;
    align-items: center;
    padding: 0.4rem 0.7rem;
    border-bottom: 1px solid var(--p-content-border-color);
    cursor: pointer;
    transition: background 0.1s;
    /* reserve enough vertical room for the hover-revealed action buttons
       (they are taller than the time/meta they replace) so the row does not
       jump when the cursor enters or leaves it. */
    min-height: 2.85rem;
}
.list-row:hover {
    background: var(--p-surface-100);
}
.aiball-dark .list-row:hover {
    background: var(--p-surface-800);
}
.list-row--selected,
.list-row--selected:hover {
    background: color-mix(in srgb, var(--p-primary-color) 12%, transparent);
}
.list-row--unread .list-row__from,
.list-row--unread .list-row__title {
    font-weight: 600;
    color: var(--p-text-color);
}
.list-row--closed {
    opacity: 0.6;
}
.list-row--pending {
    background: color-mix(in srgb, var(--p-yellow-500) 12%, transparent);
    border-left: 3px solid var(--p-yellow-500);
    padding-left: calc(0.7rem - 3px);
}
.list-row--pending:hover {
    background: color-mix(in srgb, var(--p-yellow-500) 20%, transparent);
}
.aiball-dark .list-row--pending {
    background: color-mix(in srgb, var(--p-yellow-500) 18%, transparent);
}
.list-row--danger .list-row__title {
    color: var(--p-red-500);
}

.list-row__lead {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 1rem;
}
.list-row__from {
    flex-shrink: 0;
    width: 9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--p-text-color);
    font-size: 0.92rem;
}
.list-row__main {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    font-size: 0.92rem;
}
.list-row__title {
    color: var(--p-text-color);
}
.list-row__snippet {
    color: var(--p-text-muted-color);
    margin-left: 0.4rem;
}
.list-row__snippet::before {
    content: "— ";
}
.list-row__tail {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
    min-width: 6rem;
    justify-content: flex-end;
}
.list-row__meta {
    font-size: 0.8rem;
    color: var(--p-text-muted-color);
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
}
.list-row__time {
    font-size: 0.8rem;
    color: var(--p-text-muted-color);
    white-space: nowrap;
}
.list-row__actions {
    display: none;
    align-items: center;
    gap: 0.15rem;
}
.list-row:hover .list-row__time,
.list-row:hover .list-row__meta {
    display: none;
}
.list-row:hover .list-row__actions {
    display: flex;
}

/* On touch devices we can't hover; always show actions there */
@media (hover: none) {
    .list-row__time,
    .list-row__meta { display: inline-flex; }
    .list-row__actions { display: flex; }
}
</style>
