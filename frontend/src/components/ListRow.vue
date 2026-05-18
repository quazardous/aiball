<script setup lang="ts">
import { useSlots } from "vue";

defineProps<{
    selected?: boolean;
    unread?: boolean;
    closed?: boolean;
    danger?: boolean;
    /**
     * Action attended of the current consumer on this row. Drives the row
     * tint — one tint at a time, picked by the caller per priority:
     *   "moderation" (ticket itself pending mod) > "resolution" (pending
     *   ticket_resolved awaiting reporter) > "comments" (≥1 pending
     *   comment_added awaiting mod) > null (nothing actionable).
     */
    attention?: "moderation" | "resolution" | "comments" | null;
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
            'list-row--closed': closed,
            'list-row--danger': danger,
            'list-row--attention-moderation': attention === 'moderation',
            'list-row--attention-resolution': attention === 'resolution',
            'list-row--attention-comments': attention === 'comments',
        }"
        @click="emit('click', $event)"
    >
        <div class="list-row__line list-row__line--title">
            <span v-if="slots.from" class="list-row__from"><slot name="from" /></span>
            <span class="list-row__title"><slot name="title" /></span>
            <span v-if="slots.snippet" class="list-row__snippet">
                <slot name="snippet" />
            </span>
        </div>
        <div class="list-row__line list-row__line--chips">
            <span
                v-if="slots.select"
                class="list-row__select"
                @click.stop
            ><slot name="select" /></span>
            <span
                v-if="slots.lead"
                class="list-row__lead"
                @click.stop
            ><slot name="lead" /></span>
            <slot name="chips" />
            <span class="list-row__spacer" />
            <div v-if="slots['always-actions']" class="list-row__always-actions" @click.stop>
                <slot name="always-actions" />
            </div>
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
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.4rem 0.7rem;
    border-bottom: 1px solid var(--p-content-border-color);
    cursor: pointer;
    transition: background 0.1s;
    /* Two-line rows: the title line takes the FULL row width (ref +
       title + snippet), the chip strip below carries the checkbox,
       the read toggle, the lifecycle icon, the tags, and the
       meta/time/actions on the right. */
    min-height: 3.4rem;
}
.list-row:hover {
    background: var(--p-surface-100);
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
/* Row tint = "you have something to do here". One at a time, chosen by
   priority in the caller (see ListRow `attention` prop). The colored
   LEFT BORDER stays on whatever the read state — it's the "you still
   have something to act on" signal. The FILL only kicks in when the row
   is *also* unread, so the read transition (after the auto-mark on the
   thread detail view) visibly fades the row back to "ack'd / on hold"
   without losing the action cue. */
.list-row--attention-moderation,
.list-row--attention-resolution,
.list-row--attention-comments {
    padding-left: calc(0.7rem - 3px);
}
.list-row--attention-moderation {
    border-left: 3px solid var(--p-yellow-500);
}
.list-row--attention-resolution {
    border-left: 3px solid var(--p-green-500);
}
.list-row--attention-comments {
    border-left: 3px solid color-mix(in srgb, var(--p-yellow-500) 60%, transparent);
}
/* Unread + attention → fill kicks in so the row stands out at a glance. */
.list-row--unread.list-row--attention-moderation {
    background: color-mix(in srgb, var(--p-yellow-500) 12%, transparent);
}
.list-row--unread.list-row--attention-moderation:hover {
    background: color-mix(in srgb, var(--p-yellow-500) 20%, transparent);
}
.list-row--unread.list-row--attention-resolution {
    background: color-mix(in srgb, var(--p-green-500) 10%, transparent);
}
.list-row--unread.list-row--attention-resolution:hover {
    background: color-mix(in srgb, var(--p-green-500) 18%, transparent);
}
.list-row--unread.list-row--attention-comments {
    background: color-mix(in srgb, var(--p-yellow-500) 6%, transparent);
}
.list-row--unread.list-row--attention-comments:hover {
    background: color-mix(in srgb, var(--p-yellow-500) 12%, transparent);
}
.list-row--danger .list-row__title {
    color: var(--p-red-500);
}

.list-row__lead {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
}
.list-row__select {
    display: inline-flex;
    align-items: center;
}
.list-row__from {
    color: var(--p-text-color);
    font-size: 0.92rem;
    margin-right: 0.4rem;
    /* No fixed width — the from name flows inline with the title on
       line 1, separated by a trailing space. Truncation is handled by
       the line's overall ellipsis when the title runs long. */
}
.list-row__line {
    display: flex;
    align-items: center;
    min-width: 0;
}
.list-row__line--title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
    font-size: 0.92rem;
}
.list-row__line--chips {
    flex-wrap: wrap;
    gap: 0.3rem;
    row-gap: 0.25rem;
    font-size: 0.78rem;
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
.list-row__spacer {
    flex: 1;
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
.list-row__always-actions {
    display: flex;
    align-items: center;
    gap: 0.15rem;
}
.list-row__actions {
    display: none;
    align-items: center;
    gap: 0.15rem;
}
/* Time and meta both stay visible on hover (#B.132 follow-up: david
   flagged the disappear-on-hover as a flicker). Actions slot just
   appears next to them on hover instead of replacing the time. */
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
