<script setup lang="ts">
import Tag from "primevue/tag";
import Checkbox from "primevue/checkbox";
import { type InboxRow, type SearchHit } from "../lib/api";
import ListRow from "./ListRow.vue";
import TagBadge from "./TagBadge.vue";

defineProps<{
    loading: boolean;
    rows: InboxRow[];
    project: string | null;
    selectedIds: Set<number>;
    searchActive: boolean;
    searchHits: SearchHit[];
    searchQuery: string;
}>();

const emit = defineEmits<{
    (e: "open-row", row: InboxRow): void;
    (e: "open-hit", hit: SearchHit): void;
    (e: "toggle-read", row: InboxRow): void;
    (e: "toggle-selected", id: number, value: boolean): void;
}>();

function relativeTime(iso: string): string {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = 60_000, hr = 3_600_000, day = 86_400_000;
    if (diff < hr) return `${Math.max(1, Math.floor(diff / min))}m ago`;
    if (diff < day) return `${Math.floor(diff / hr)}h ago`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
    return d.toLocaleDateString();
}

function snippetOf(r: InboxRow): string {
    const s = r.body ?? "";
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > 140 ? flat.slice(0, 140) + "…" : flat;
}

function titleOf(r: InboxRow): string {
    return r.title ?? "(no title)";
}

function statusSeverity(s: InboxRow["status"]) {
    if (s === "pending") return "warn";
    if (s === "approved") return "success";
    return "danger";
}

function intentSeverity(p: InboxRow["intent"]) {
    if (p === "panic") return "danger";
    if (p === "request") return "info";
    if (p === "question") return "warn";
    return "secondary";
}

/**
 * Pick the row tint per the workflow design (see #B148):
 *   moderation > resolution > comments > null
 * — at most one accent at a time, chosen by the most urgent action
 * waiting on the consumer. `null` = nothing to do, row stays neutral.
 */
function attentionOf(r: InboxRow): "moderation" | "resolution" | "comments" | null {
    if (r.status === "pending") return "moderation";
    if (r.pending_resolution) return "resolution";
    if (r.pending_comment_count > 0) return "comments";
    return null;
}
</script>

<template>
    <div v-if="loading && !rows.length && !searchHits.length" class="aiball-empty">
        Loading…
    </div>
    <div v-else-if="searchActive && !searchHits.length" class="aiball-empty">
        <i class="pi pi-search" style="font-size: 1.6rem" />
        <div>No matches for « {{ searchQuery }} ».</div>
    </div>
    <div v-else-if="!searchActive && !rows.length" class="aiball-empty">
        <i class="pi pi-inbox" style="font-size: 1.6rem" />
        <div>
            No tickets match your filters{{ project ? ` in ${project}` : "" }}.
        </div>
    </div>

    <a
        v-for="hit in searchHits"
        :key="`${hit.kind}-${hit.id}`"
        :href="`/b/${hit.kind === 'comment' && hit.hashid ? hit.hashid : hit.ticket_id}`"
        class="search-hit"
        @click.prevent="emit('open-hit', hit)"
    >
        <div class="search-hit__head">
            <span class="ticket-id">
                {{ hit.kind === 'comment' ? `#C.${hit.hashid ?? hit.id}` : `#B.${hit.ticket_id}` }}
            </span>
            <Tag :value="hit.project" severity="info" style="font-size: 0.7rem" />
            <Tag
                v-if="hit.status !== 'approved'"
                :value="hit.status"
                :severity="statusSeverity(hit.status)"
                style="font-size: 0.7rem"
            />
            <span v-if="hit.title" class="search-hit__title">{{ hit.title }}</span>
            <span class="spacer" />
            <span class="search-hit__by" v-if="hit.by_agent">by {{ hit.by_agent }}</span>
        </div>
        <div class="search-hit__snippet" v-html="hit.snippet" />
    </a>

    <ListRow
        v-if="!searchActive"
        v-for="r in rows"
        :key="r.id"
        :selected="selectedIds.has(r.id)"
        :unread="r.unread"
        :closed="r.closed"
        :attention="attentionOf(r)"
        @click="emit('open-row', r)"
    >
        <template #select>
            <Checkbox
                :model-value="selectedIds.has(r.id)"
                binary
                @update:model-value="(v: boolean) => emit('toggle-selected', r.id, v)"
            />
        </template>
        <template #lead>
            <!--
                Read / unread toggle (per #C.tukrab on #B.58).
                Sits at the START of the row so it doubles as
                the read-state indicator (envelope closed when
                unread, envelope open when read). Clicking
                flips the state for this consumer.
            -->
            <button
                type="button"
                class="read-toggle-lead"
                :class="{ 'read-toggle-lead--unread': r.unread }"
                :title="r.unread ? 'Unread — click to mark read' : 'Read — click to mark unread'"
                :aria-pressed="r.unread"
                @click.stop="emit('toggle-read', r)"
            >
                <i class="pi pi-envelope" />
            </button>
            <!-- Lifecycle stage — single icon per row, deterministic. -->
            <i
                v-if="r.status === 'rejected'"
                class="pi pi-times-circle"
                title="rejected ticket"
                style="color: var(--p-red-500)"
            />
            <i
                v-else-if="r.closed && r.resolved"
                class="pi pi-check-circle"
                title="closed (resolved)"
                style="color: var(--p-green-600)"
            />
            <i
                v-else-if="r.closed"
                class="pi pi-lock"
                title="closed without explicit resolution (wontfix / abandoned / duplicate)"
                style="color: var(--p-orange-500)"
            />
            <i
                v-else-if="r.resolved"
                class="pi pi-check-circle"
                title="resolved (proposal accepted, reporter has not closed yet)"
                style="color: var(--p-green-500)"
            />
            <i
                v-else-if="r.postponed"
                class="pi pi-history"
                :title="r.postponed_until
                    ? `snoozed until ${new Date(r.postponed_until).toLocaleString()}`
                    : 'snoozed'"
                style="color: var(--p-indigo-500)"
            />
            <i
                v-else
                class="pi pi-ticket"
                style="color: var(--p-text-muted-color)"
                title="open ticket"
            />
        </template>
        <template v-if="r.by_agent" #from>{{ r.by_agent }}</template>
        <template #title>
            <span class="ticket-id">#B.{{ r.id }}</span>
            {{ titleOf(r) }}
            <i
                v-if="r.broadcast"
                class="pi pi-megaphone"
                style="margin-left: 0.35rem; color: var(--p-blue-500); font-size: 0.85rem"
                title="broadcast: project followers receive pings on this thread"
            />
        </template>
        <template v-if="snippetOf(r)" #snippet>{{ snippetOf(r) }}</template>
        <template
            v-if="r.status !== 'approved' || r.intent || r.tags.length || !project"
            #chips
        >
            <Tag
                v-if="r.status !== 'approved'"
                :value="r.status"
                :severity="statusSeverity(r.status)"
                style="font-size: 0.7rem"
            />
            <Tag
                v-if="r.intent"
                :value="r.intent"
                :severity="intentSeverity(r.intent)"
                style="font-size: 0.7rem"
            />
            <TagBadge
                v-for="tg in r.tags"
                :key="tg.id"
                :tag="tg"
                size="sm"
            />
            <Tag
                v-if="!project"
                :value="r.project"
                severity="info"
                style="font-size: 0.7rem"
            />
        </template>
        <template #meta>
            <span v-if="r.pending_comment_count > 0" :title="`${r.pending_comment_count} pending comment${r.pending_comment_count > 1 ? 's' : ''}`">
                <i class="pi pi-clock" /> {{ r.pending_comment_count }}
            </span>
            <span v-else-if="r.comment_count > 0">
                <i class="pi pi-comments" /> {{ r.comment_count }}
            </span>
        </template>
        <template #time>{{ relativeTime(r.last_activity) }}</template>
    </ListRow>
</template>
