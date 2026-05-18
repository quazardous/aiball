<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { useToast } from "primevue/usetoast";
import { api, type Consumer } from "../lib/api";
import ConsumerEditPage from "./ConsumerEditPage.vue";

// Set on /consumers/<id> → render the dedicated edit view. Parent
// (App.vue) owns the ref so browser back/forward works (#B.193).
const props = defineProps<{
    editConsumerId?: string | null;
}>();
const emit = defineEmits<{
    (e: "open-edit", consumerId: string): void;
    (e: "close-edit"): void;
}>();

// #B.177: how long without a state heartbeat before we render the
// loop agent as "offline" in the Activity badge. Matches david's
// 60s default from the design comment on the ticket.
const OFFLINE_THRESHOLD_MS = 60_000;

// Tick-clock so "2 min ago" updates without re-fetching the API.
const now = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;

const toast = useToast();
const rows = ref<Consumer[]>([]);
const loading = ref(false);

// Hide consumers idle > 1 week by default; toggle reveals the long
// tail for debugging (#B.193).
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const hideStale = ref(true);

async function load() {
    loading.value = true;
    try {
        rows.value = await api.listConsumers();
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Failed to load consumers",
            detail: (e as Error).message,
            life: 8000,
        });
    } finally {
        loading.value = false;
    }
}

async function remove(consumer_id: string) {
    if (!confirm(`Delete consumer "${consumer_id}"? Past posts are preserved; the row will be re-created the next time this id posts.`)) return;
    try {
        await api.deleteConsumer(consumer_id);
        rows.value = rows.value.filter((r) => r.consumer_id !== consumer_id);
    } catch (e) {
        toast.add({
            severity: "error",
            summary: `Delete failed for ${consumer_id}`,
            detail: (e as Error).message,
            life: 6000,
        });
    }
}

onMounted(() => {
    load();
    // Live-poll the consumers list so the activity column reflects
    // heartbeats from claude-loop timers without manual refresh.
    nowTimer = setInterval(() => {
        now.value = Date.now();
        // Re-fetch every 5 ticks (~30s) — cheap, gets state changes.
        if (Math.floor(now.value / 1000) % 30 === 0) void load();
    }, 6_000);
});
onUnmounted(() => {
    if (nowTimer) clearInterval(nowTimer);
});

// =====================================================================
// #B.177 Activity column helpers
// =====================================================================

function relativeTime(iso: string | null | undefined): string {
    if (!iso) return "never";
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    const diff = now.value - t;
    if (diff < 0) return "just now";
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** True when the consumer is a claude-loop agent whose last heartbeat
 *  is older than OFFLINE_THRESHOLD_MS — the timer process is likely
 *  gone or wedged. */
function isOffline(r: Consumer): boolean {
    if (!r.state || !r.state_updated_at) return false;
    const t = Date.parse(r.state_updated_at);
    if (!Number.isFinite(t)) return false;
    return now.value - t > OFFLINE_THRESHOLD_MS;
}

function loopBadgeLabel(r: Consumer): string {
    if (isOffline(r)) return "offline";
    return r.state ?? "";
}

function loopBadgeSeverity(r: Consumer): "info" | "secondary" | "warn" {
    if (isOffline(r)) return "secondary";
    if (r.state === "busy") return "info";    // electric blue — matches tmux bar
    if (r.state === "boot") return "warn";    // yellow
    return "secondary";                        // idle = gray
}

function loopBadgeTooltip(r: Consumer): string {
    if (!r.state) return "no claude-loop activity recorded";
    if (isOffline(r))
        return `last heartbeat ${relativeTime(r.state_updated_at)} — timer likely down`;
    return `${r.state} since ${relativeTime(r.state_since)}`;
}

const hasLoopAgents = computed(() => rows.value.some((r) => !!r.state));
void hasLoopAgents; // referenced in template via direct access

// =====================================================================
// #B.177 david: clickable column headers for sort/tri
// =====================================================================

type SortKey = "consumer_id" | "kind" | "display_name" | "activity" | "enabled";
// Default sort: most-recent activity first (#B.193).
const sortKey = ref<SortKey>("activity");
const sortDir = ref<"asc" | "desc">("desc");

function toggleSort(key: SortKey): void {
    if (sortKey.value === key) {
        sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
    } else {
        sortKey.value = key;
        sortDir.value = "asc";
    }
}

function sortIcon(key: SortKey): string {
    if (sortKey.value !== key) return "pi pi-sort";
    return sortDir.value === "asc" ? "pi pi-sort-up" : "pi pi-sort-down";
}

// Filter before sort so empty-state badges reflect the visible
// row count. Consumers with no last_seen_at count as stale (#B.193).
const visibleRows = computed<Consumer[]>(() => {
    if (!hideStale.value) return rows.value;
    const threshold = Date.now() - STALE_THRESHOLD_MS;
    return rows.value.filter((r) => {
        if (!r.last_seen_at) return false;
        return Date.parse(r.last_seen_at) >= threshold;
    });
});

const sortedRows = computed<Consumer[]>(() => {
    const mul = sortDir.value === "asc" ? 1 : -1;
    return [...visibleRows.value].sort((a, b) => {
        switch (sortKey.value) {
            case "consumer_id":
                return mul * a.consumer_id.localeCompare(b.consumer_id);
            case "kind":
                return mul * a.kind.localeCompare(b.kind);
            case "display_name":
                return mul * (a.display_name ?? "").localeCompare(b.display_name ?? "");
            case "enabled":
                // Enabled-first when asc.
                return mul * (Number(b.enabled) - Number(a.enabled));
            case "activity": {
                // Sort by last_seen_at. Follow the conventional
                // direction: asc = OLDEST first (smallest timestamp),
                // desc = most recent first. David flagged "ordre pas
                // bon pour le temp" — earlier impl had it inverted.
                // Null last_seen_at = treated as oldest (epoch).
                const ta = a.last_seen_at ? Date.parse(a.last_seen_at) : 0;
                const tb = b.last_seen_at ? Date.parse(b.last_seen_at) : 0;
                return mul * (ta - tb);
            }
        }
    });
});</script>

<template>
    <ConsumerEditPage
        v-if="props.editConsumerId"
        :consumer-id="props.editConsumerId"
        @close="emit('close-edit')"
    />
    <div v-else class="consumers-panel">
        <header class="rules-explainer-block">
            <h2 style="margin: 0">Consumers</h2>
            <p class="rules-explainer rules-explainer--muted">
                One row per <code>consumer_id</code> the daemon has seen.
                <em>Human</em> = moderator (bypasses moderation, closes / snoozes any ticket);
                <em>agent</em> = anyone else. Click the pencil to edit, the envelope to block.
            </p>
        </header>

        <section class="consumers-toolbar">
            <label class="consumers-toolbar__toggle">
                <input
                    type="checkbox"
                    :checked="hideStale"
                    @change="hideStale = ($event.target as HTMLInputElement).checked"
                />
                Hide consumers idle &gt; 1 week
            </label>
            <span class="consumers-toolbar__count">
                {{ sortedRows.length }} shown / {{ rows.length }} total
            </span>
        </section>

        <div v-if="loading && !rows.length" class="aiball-empty">Loading…</div>
        <div v-else-if="!rows.length" class="aiball-empty">
            <i class="pi pi-users" style="font-size: 1.6rem" />
            <div>No consumers yet — anyone who posts will be added here automatically.</div>
        </div>

        <div v-else class="consumers-table-wrap">
        <table class="consumers-table">
            <thead>
                <tr>
                    <th class="sortable" @click="toggleSort('consumer_id')">
                        Consumer id <i :class="sortIcon('consumer_id')" />
                    </th>
                    <th class="sortable col-kind" @click="toggleSort('kind')">
                        Kind <i :class="sortIcon('kind')" />
                    </th>
                    <th class="sortable col-display" @click="toggleSort('display_name')">
                        Display name <i :class="sortIcon('display_name')" />
                    </th>
                    <th class="sortable" @click="toggleSort('activity')">
                        Activity <i :class="sortIcon('activity')" />
                    </th>
                    <th class="sortable col-enabled" @click="toggleSort('enabled')">
                        Active <i :class="sortIcon('enabled')" />
                    </th>
                    <th />
                </tr>
            </thead>
            <tbody>
                <tr v-for="r in sortedRows" :key="r.consumer_id" :class="{ 'is-blocked': !r.enabled }">
                    <td class="consumers-cid">
                        <div class="consumers-cid__inner">
                            <span class="consumers-cid__text">{{ r.consumer_id }}</span>
                            <Tag
                                v-if="r.kind === 'human'"
                                value="moderator"
                                severity="success"
                                class="consumers-cid__tag"
                            />
                            <Tag
                                v-else-if="r.kind === 'sandbox'"
                                value="sandbox"
                                severity="warn"
                                class="consumers-cid__tag"
                            />
                        </div>
                    </td>
                    <td class="col-kind">{{ r.kind }}</td>
                    <td class="col-display">{{ r.display_name ?? "" }}</td>
                    <td class="activity-cell">
                        <div
                            class="activity-cell__seen"
                            :title="r.last_seen_at ?? 'never seen'"
                        >
                            {{ relativeTime(r.last_seen_at) }}
                        </div>
                        <Tag
                            v-if="r.state"
                            :value="loopBadgeLabel(r)"
                            :severity="loopBadgeSeverity(r)"
                            :title="loopBadgeTooltip(r)"
                            class="activity-cell__state"
                        />
                    </td>
                    <td class="col-enabled">
                        <Tag
                            :value="r.enabled ? 'enabled' : 'blocked'"
                            :severity="r.enabled ? 'success' : 'danger'"
                        />
                    </td>
                    <td class="action-cell">
                        <div class="action-cell__inner">
                            <Button
                                icon="pi pi-pencil"
                                text
                                rounded
                                size="small"
                                :title="`Edit ${r.consumer_id} on a dedicated page`"
                                @click="emit('open-edit', r.consumer_id)"
                            />
                            <Button
                                icon="pi pi-trash"
                                severity="danger"
                                text
                                rounded
                                size="small"
                                :title="`Delete consumer ${r.consumer_id} (history preserved)`"
                                @click="remove(r.consumer_id)"
                            />
                        </div>
                    </td>
                </tr>
            </tbody>
        </table>
        </div>
    </div>
</template>

<style>
.consumers-panel {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
}
.consumers-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.4rem 0.2rem;
}
.consumers-toolbar__toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.9rem;
    cursor: pointer;
    user-select: none;
}
.consumers-toolbar__count {
    font-size: 0.82rem;
    color: var(--p-text-muted-color);
}
.consumers-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.92rem;
}
.consumers-table th,
.consumers-table td {
    text-align: left;
    padding: 0.5rem 0.6rem;
    border-bottom: 1px solid var(--p-content-border-color);
    vertical-align: middle;
    /* Pin row height so PrimeVue components with mildly different
       intrinsic heights (Select vs Button text vs Button rounded)
       can't drift between rows. */
    height: 3rem;
}
.consumers-cid {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.85rem;
}
.consumers-cid__inner {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: nowrap;
    min-width: 0;
}
.consumers-cid__text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.consumers-cid__tag {
    font-size: 0.7rem;
    flex-shrink: 0;
}
.consumers-table tr.is-blocked {
    opacity: 0.55;
}
/* Use a .consumers-table-scoped selector — there's a sibling
   .action-cell rule in ProjectsPanel.vue (non-scoped styles bleed
   across components) that forces display: flex on td which breaks
   the table layout here (#B.150). */
.consumers-table .action-cell {
    display: table-cell;
    text-align: right;
    /* #B.177 david: "chevauchement de l'icone delete avec la barre
       scroll" — when the table overflows horizontally, the scroll
       bar sat on top of the action button. Bump the width + add
       right padding so the icon is inset away from any scrollbar
       gutter. */
    width: 4rem;
    padding-right: 0.75rem;
}
.consumers-table .action-cell__inner {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    /* Match the intrinsic height of the PrimeVue Select/Input in the
       other cells (~39px) so this cell's total height equals theirs
       and the row's border-bottom aligns across all columns. */
    min-height: 2.4375rem;
    line-height: 1;
}
/* #B.177 david: clickable sort headers */
.consumers-table th.sortable {
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
}
.consumers-table th.sortable:hover {
    color: var(--p-primary-color);
}
.consumers-table th.sortable i {
    font-size: 0.75em;
    margin-left: 0.25rem;
    opacity: 0.55;
}
/* #B.177 Activity column */
.consumers-table .activity-cell {
    display: table-cell;
    min-width: 8rem;
    vertical-align: middle;
}
.consumers-table .activity-cell__seen {
    font-size: 0.85em;
    color: var(--p-text-muted-color);
}
.consumers-table .activity-cell__state {
    margin-top: 2px;
}
/* #B.193 mobile compaction — keep table inside viewport, scroll as a
   last resort if a long consumer_id still overflows. */
.consumers-table-wrap {
    width: 100%;
    overflow-x: auto;
}
/* Phone-sized: drop the redundant columns. `kind` is already shown as
   an inline tag next to the consumer id (moderator/sandbox); `display
   name` is secondary and lives on the edit page; `enabled` is implicit
   from `tr.is-blocked` row dimming. Tighter paddings + drop the
   pinned height + min-width so rows stack without horizontal overflow. */
@media (max-width: 640px) {
    .consumers-table .col-kind,
    .consumers-table .col-display,
    .consumers-table .col-enabled {
        display: none;
    }
    .consumers-table th,
    .consumers-table td {
        padding: 0.4rem 0.35rem;
        height: auto;
    }
    /* With only 3 visible cells, force the browser to stretch the
       consumer_id column and shrink Activity + Actions to their
       intrinsic widths — otherwise the table distributes free space
       between Activity and Actions and you get a big blank gap
       between them. */
    .consumers-table .consumers-cid {
        width: 99%;
    }
    .consumers-table .activity-cell {
        min-width: 0;
        width: 1%;
        white-space: nowrap;
    }
    .consumers-table .action-cell {
        width: 1%;
        padding-right: 0.25rem;
    }
}
</style>
