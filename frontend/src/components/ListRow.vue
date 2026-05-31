<script setup lang="ts">
import { ref, useSlots } from "vue";

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
    /**
     * #656 david `2c9qm4`: only applicable when attention === "resolution".
     * True iff the pending decision is the LATEST comment on the thread
     * (fresh proposal, nothing posted after) — band stays SOLID. False
     * means the conversation continued past the proposal — band turns
     * DASHED to signal the proposal is hanging but no longer the freshest
     * signal.
     */
    resolutionFresh?: boolean;
}>();
const emit = defineEmits<{
    (e: "click", ev: MouseEvent): void;
    /** #B.255 — long-press on touch devices (~500ms hold without
     *  scrolling). The consumer wires this to toggle bulk selection
     *  so phone users don't have to aim at the tiny checkbox. */
    (e: "long-press", ev: TouchEvent): void;
}>();

const slots = useSlots();

// #B.255 long-touch bulk selection. Mobile-only flow:
//   1. `touchstart`  → arm a 500 ms timer + capture origin coords.
//   2. `touchmove`   → cancel if the finger moves > 10 px (= scroll).
//   3. `touchend`    → cancel if released before the timer fires
//                      (regular tap, browser will emit `click`
//                      separately).
//   4. timer fires   → emit `long-press`, suppress the upcoming
//                      `click` via `suppressClick`, snap the visual
//                      cue off.
// Desktop is unaffected — none of this listens to `mousedown`.
const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;
const isLongPressing = ref(false);
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let touchOrigin: { x: number; y: number } | null = null;
let suppressClick = false;

function cancelLongPress() {
    if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
    }
    touchOrigin = null;
    isLongPressing.value = false;
}

function onTouchStart(ev: TouchEvent) {
    if (ev.touches.length !== 1) return;
    // #B.255 qp5hqv: clear any stale `suppressClick` left over from a
    // prior long-press. The suppression must only consume the
    // SYNTHETIC click that mobile browsers auto-fire after touchend —
    // a fresh user touch starts a new interaction and the next click
    // is a real tap (deselecting the just-long-pressed row is the
    // canonical case).
    suppressClick = false;
    const t = ev.touches[0];
    touchOrigin = { x: t.clientX, y: t.clientY };
    isLongPressing.value = true;
    longPressTimer = setTimeout(() => {
        suppressClick = true;
        isLongPressing.value = false;
        longPressTimer = null;
        emit("long-press", ev);
    }, LONG_PRESS_MS);
}

function onTouchMove(ev: TouchEvent) {
    if (!touchOrigin || longPressTimer === null) return;
    const t = ev.touches[0];
    const dx = Math.abs(t.clientX - touchOrigin.x);
    const dy = Math.abs(t.clientY - touchOrigin.y);
    if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) {
        cancelLongPress();
    }
}

function onTouchEnd() {
    // If the timer hasn't fired, this is a tap → let the click pass
    // through. If it has fired, `suppressClick` was set and the
    // next click handler short-circuits.
    cancelLongPress();
}

function onClick(ev: MouseEvent) {
    if (suppressClick) {
        suppressClick = false;
        ev.stopPropagation();
        ev.preventDefault();
        return;
    }
    emit("click", ev);
}
</script>

<template>
    <div
        class="list-row"
        :class="{
            'list-row--selected': selected,
            'list-row--unread': unread,
            'list-row--closed': closed,
            'list-row--danger': danger,
            'list-row--long-pressing': isLongPressing,
            'list-row--attention-moderation': attention === 'moderation',
            'list-row--attention-resolution': attention === 'resolution',
            'list-row--attention-resolution-fresh': attention === 'resolution' && resolutionFresh,
            'list-row--attention-comments': attention === 'comments',
        }"
        @click="onClick"
        @touchstart.passive="onTouchStart"
        @touchmove.passive="onTouchMove"
        @touchend="onTouchEnd"
        @touchcancel="onTouchEnd"
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
    /* #530 (suite cerqc8) : padding vertical réduit 0.4→0.25rem pour
       compenser la combo line-height:1.5 + padding-bottom:0.25rem sur le
       title line (cf. plus bas). Net : row sensiblement même hauteur
       qu'avant, mais le title line a maintenant DEUX leviers contre le
       clip descender (line box tall + padding safety net). */
    padding: 0.25rem 0.7rem;
    /* #530 (suite 2k5nfe) : `flex-shrink: 0` empêche le main parent
       (display:flex column avec height fixé) de squeeze les rows quand
       la liste est longue. Avant : rows comprimées à min-height (54.4px)
       → flex distribue les enfants → soit title se compresse en clip
       descender soit chips débordent. Avec flex-shrink 0 sur le row,
       chaque row prend SA taille naturelle (~61.4px), main scrolle si
       besoin (overflow:auto déjà set). Cohérent avec le min-height qui
       agit comme floor visuel pour les rows COURTES. */
    flex-shrink: 0;
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
/* #B.255 qp5hqv: selected state — flashy orange glow (david: la
   couleur verte ressemblait à un état existant). Inset box-shadow
   gives a 2px loud border without affecting layout; outer shadow
   gives the glow halo. Background stays subtle so the glow does the
   visual work. */
.list-row--selected,
.list-row--selected:hover {
    background: color-mix(in srgb, var(--p-orange-500) 6%, transparent);
    box-shadow:
        inset 0 0 0 2px var(--p-orange-500),
        0 0 6px color-mix(in srgb, var(--p-orange-500) 60%, transparent);
    position: relative;
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
    /* #656 david `8wegju` + `2c9qm4` : la bande verte est DASHED par
       défaut (proposition pending mais discussion continuée après) et
       repasse SOLID via `--attention-resolution-fresh` quand la
       proposition est le dernier message du thread (fresh, untouched).
       Pointillé connote "à valider, pas figé" ; solid connote "fresh
       agent proposal, clean state, your call". */
    border-left: 3px dashed var(--p-green-500);
}
.list-row--attention-resolution-fresh {
    border-left-style: solid;
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
    /* #530 (suite 2k5nfe — repro Win Chrome DPI 1.25 via claude-in-chrome) :
       ROOT CAUSE trouvée — la title-line se faisait shrink par le flex
       distribution dans .list-row (min-height 3.4rem capait la row, et
       title shrinkait pour fitter — chips ne shrinkaient pas, glyphs
       fixés). Title content area passait de 26px naturel à 19px → clip
       de 7px sur les descenders.
       Fix : `flex-shrink: 0` empêche la title-line de shrink dans le flex
       parent. La row grow alors au-delà de son min-height pour fitter le
       title à sa taille naturelle. Side : rows peuvent être qq px plus
       hauts en cas de long title, mais zero descender clip.
       Combo line-height 1.5 + padding-bottom 0.25rem maintenu (belt-and-
       suspenders) pour DPI extrême / fonts exotiques au cas où. */
    flex-shrink: 0;
    line-height: 1.5;
    padding-bottom: 0.25rem;
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
    /* #B.255: suppress the native long-press menu (Copy / Share …)
       on touch since we hijack the same gesture for bulk select. */
    .list-row {
        -webkit-touch-callout: none;
        -webkit-user-select: none;
        user-select: none;
    }
}

/* #B.255 long-press visual cue. While the finger is held (500 ms
   window), the row tints with a subtle accent and grows a left
   ribbon that fills toward the trigger threshold. When the long-press
   fires the row flips to its --selected state via the consumer's
   bulk toggle; until then this is the only feedback. */
.list-row--long-pressing {
    background: color-mix(in srgb, var(--p-primary-color) 8%, transparent);
    position: relative;
}
.list-row--long-pressing::after {
    content: "";
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--p-primary-color);
    animation: list-row-long-press 0.5s linear forwards;
    pointer-events: none;
}
@keyframes list-row-long-press {
    from { transform: scaleY(0); transform-origin: top; }
    to   { transform: scaleY(1); transform-origin: top; }
}
</style>
