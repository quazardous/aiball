<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import ToggleButton from "primevue/togglebutton";
import { api, type Message, type TicketSummary } from "../lib/api";

const props = defineProps<{ project: string | null }>();
const emit = defineEmits<{ (e: "open", id: number): void }>();

const tickets = ref<TicketSummary[]>([]);
const comments = ref<Message[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const onlyOpen = ref(true);

async function load() {
    loading.value = true;
    error.value = null;
    try {
        const [t, c] = await Promise.all([
            api.listTickets({
                project: props.project ?? undefined,
                open: onlyOpen.value,
            }),
            api.listMessages({
                project: props.project ?? undefined,
                kind: "comment_added",
                status: "approved",
                limit: 500,
            }),
        ]);
        tickets.value = t;
        comments.value = c;
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        loading.value = false;
    }
}

watch(() => [props.project, onlyOpen.value], load);
onMounted(load);
defineExpose({ load });

interface Aug extends TicketSummary {
    commentCount: number;
    lastActivity: string;
}

const augmented = computed<Aug[]>(() => {
    const counts = new Map<number, { count: number; last: string }>();
    for (const c of comments.value) {
        if (!c.ticket_id) continue;
        const cur = counts.get(c.ticket_id) ?? { count: 0, last: "" };
        cur.count += 1;
        if (c.created_at > cur.last) cur.last = c.created_at;
        counts.set(c.ticket_id, cur);
    }
    return tickets.value
        .map((t) => {
            const c = counts.get(t.id) ?? { count: 0, last: "" };
            return {
                ...t,
                commentCount: c.count,
                lastActivity:
                    c.last && c.last > t.created_at ? c.last : t.created_at,
            };
        })
        .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
});
</script>

<template>
    <div class="ticket-list">
        <div class="ticket-list-toolbar">
            <ToggleButton
                v-model="onlyOpen"
                on-label="open only"
                off-label="all"
                on-icon="pi pi-folder-open"
                off-icon="pi pi-folder"
                size="small"
            />
            <span class="spacer" />
            <Button
                icon="pi pi-refresh"
                severity="secondary"
                text
                rounded
                :loading="loading"
                @click="load"
            />
        </div>

        <div v-if="error" class="aiball-empty" style="color: var(--p-red-500)">
            {{ error }}
        </div>
        <div v-else-if="!loading && augmented.length === 0" class="aiball-empty">
            <i class="pi pi-inbox" style="font-size: 1.6rem" />
            <div>
                No {{ onlyOpen ? "open" : "" }} tickets{{
                    project ? ` in ${project}` : ""
                }}.
            </div>
        </div>

        <div
            v-for="t in augmented"
            :key="t.id"
            class="ticket-row"
            :class="{ closed: t.closed }"
            @click="emit('open', t.id)"
        >
            <div class="ticket-row-meta">
                <Tag :value="`#${t.id}`" severity="secondary" />
                <Tag :value="t.project" severity="info" />
                <Tag v-if="t.closed" value="closed" severity="danger" />
                <span v-if="t.by_agent">by {{ t.by_agent }}</span>
                <span class="spacer" />
                <span :title="t.lastActivity" style="font-size: 0.85rem">
                    {{ new Date(t.lastActivity).toLocaleString() }}
                </span>
            </div>
            <div class="ticket-row-title">{{ t.title || "(no title)" }}</div>
            <div class="ticket-row-footer">
                <i class="pi pi-comments" />
                <span>{{ t.commentCount }} comment{{ t.commentCount === 1 ? "" : "s" }}</span>
                <span class="spacer" />
                <Button
                    label="open"
                    icon="pi pi-arrow-right"
                    severity="secondary"
                    size="small"
                    text
                    @click.stop="emit('open', t.id)"
                />
            </div>
        </div>
    </div>
</template>

<style>
.ticket-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}
.ticket-list-toolbar {
    display: flex;
    align-items: center;
}
.ticket-row {
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.5rem;
    padding: 0.7rem 0.9rem;
    background: var(--p-content-background);
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    cursor: pointer;
    transition: background 0.15s;
}
.ticket-row:hover {
    background: var(--p-surface-100);
}
.aiball-dark .ticket-row:hover {
    background: var(--p-surface-800);
}
.ticket-row.closed {
    opacity: 0.6;
}
.ticket-row-meta {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    color: var(--p-text-muted-color);
    font-size: 0.85rem;
}
.ticket-row-title {
    font-weight: 600;
    font-size: 1rem;
}
.ticket-row-footer {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
}
</style>
