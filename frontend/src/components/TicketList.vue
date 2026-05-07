<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import ToggleButton from "primevue/togglebutton";
import { api, type Message, type TicketSummary } from "../lib/api";
import ListRow from "./ListRow.vue";
import TagBadge from "./TagBadge.vue";

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
    snippet: string;
}

function snippet(s: string | null | undefined, n = 120): string {
    if (!s) return "";
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

function relativeTime(iso: string): string {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = 60_000, hr = 3_600_000, day = 86_400_000;
    if (diff < hr) return `${Math.max(1, Math.floor(diff / min))}m ago`;
    if (diff < day) return `${Math.floor(diff / hr)}h ago`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
    return d.toLocaleDateString();
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
                snippet: snippet(t.body),
            };
        })
        .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
});
</script>

<template>
    <div class="ticket-list">
        <div class="list-toolbar">
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

        <ListRow
            v-for="t in augmented"
            :key="t.id"
            :closed="t.closed"
            @click="emit('open', t.id)"
        >
            <template #lead>
                <i
                    class="pi"
                    :class="t.closed ? 'pi-lock' : 'pi-ticket'"
                    style="color: var(--p-text-muted-color)"
                />
            </template>
            <template v-if="t.by_agent" #from>{{ t.by_agent }}</template>
            <template #title>
                <span class="ticket-id">#{{ t.id }}</span>
                {{ t.title || "(no title)" }}
                <TagBadge
                    v-for="tg in t.tags"
                    :key="tg.id"
                    :tag="tg"
                    size="sm"
                    style="margin-left: 0.3rem"
                />
                <Tag
                    v-if="!project"
                    :value="t.project"
                    severity="info"
                    style="margin-left: 0.4rem; font-size: 0.7rem"
                />
                <Tag
                    v-if="t.closed"
                    value="closed"
                    severity="danger"
                    style="margin-left: 0.4rem; font-size: 0.7rem"
                />
            </template>
            <template v-if="t.snippet" #snippet>{{ t.snippet }}</template>
            <template #meta>
                <span v-if="t.commentCount > 0">
                    <i class="pi pi-comments" /> {{ t.commentCount }}
                </span>
            </template>
            <template #time>{{ relativeTime(t.lastActivity) }}</template>
            <template #actions>
                <Button
                    icon="pi pi-arrow-right"
                    severity="secondary"
                    text
                    rounded
                    size="small"
                    title="open thread"
                    @click="emit('open', t.id)"
                />
            </template>
        </ListRow>
    </div>
</template>

<style>
.ticket-list {
    display: flex;
    flex-direction: column;
    gap: 0;
}
.list-toolbar {
    display: flex;
    align-items: center;
    padding: 0.3rem 0;
    gap: 0.4rem;
}
.ticket-id {
    color: var(--p-text-muted-color);
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.85em;
    margin-right: 0.4rem;
}
</style>
