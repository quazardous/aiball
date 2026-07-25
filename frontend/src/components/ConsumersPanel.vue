<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Tag from "primevue/tag";
import { useToast } from "primevue/usetoast";
import { api, type Consumer, type NodeView } from "../lib/api";
import { relativeTimeFine } from "../lib/format";
import { useNowTicker } from "../lib/now-ticker";
import { OFFLINE_THRESHOLD_MS, STALE_THRESHOLD_MS } from "../lib/time";
import { useLoader } from "../lib/loader";
import ConsumerEditPage from "./ConsumerEditPage.vue";
import DataList, { type DataListColumn } from "./ui/DataList.vue";
import PanelHeader from "./ui/PanelHeader.vue";

// Set on /consumers/<id> → render the dedicated edit view. Parent
// (App.vue) owns the ref so browser back/forward works (#B.193).
const props = defineProps<{
    editConsumerId?: string | null;
}>();
const emit = defineEmits<{
    (e: "open-edit", consumerId: string): void;
    (e: "close-edit"): void;
    // #455: jump to the detail page of the proxy node that relays this consumer.
    (e: "open-node", nodeId: string): void;
    /** #458 — forwarded from ConsumerEditPage's "Inbox" breadcrumb. Resets
     *  panel + consumer-edit slot in one shot instead of double-back. */
    (e: "close-to-inbox"): void;
}>();

// #B.177 / #280 : offline threshold — moved to lib/time.ts (C2 slice 5),
// rationale documented there (~4× the default heartbeat).

// Tick-clock so "2 min ago" updates without re-fetching the API ; the
// periodic ~30s refetch belt (missed-WS-event safety net) rides its onTick.
const now = useNowTicker(6_000, (t) => {
    if (Math.floor(t / 1000) % 30 === 0) void load();
});

const toast = useToast();
const rows = ref<Consumer[]>([]);

// #455: proxy-node enrichment.
const nodesByIp = ref<Map<string, { node_id: string; label: string | null }>>(new Map());
async function loadNodes(): Promise<void> {
    try {
        const nodes: NodeView[] = await api.listNodes();
        const m = new Map<string, { node_id: string; label: string | null }>();
        for (const n of nodes) if (n.last_seen_ip) m.set(n.last_seen_ip, { node_id: n.node_id, label: n.label });
        nodesByIp.value = m;
    } catch { /* best-effort */ }
}
function nodeFor(r: Consumer): { node_id: string; label: string | null } | null {
    if (r.last_seen_via !== "node" || !r.last_seen_ip) return null;
    return nodesByIp.value.get(r.last_seen_ip) ?? null;
}

// Hide consumers idle > 1 week by default; toggle reveals the long
// tail for debugging (#B.193).
const hideStale = ref(true);

// #443: refetch live when a loop's presence flips (dedicated consumer
// lane — no longer piggybacking on projects.refresh).
const { loading, load } = useLoader(async () => {
    rows.value = await api.listConsumers();
}, {
    onError: (detail) => toast.add({ severity: "error", summary: "Failed to load consumers", detail, life: 8000 }),
    refreshOn: ["consumers.refresh"],
});

onMounted(() => {
    load();
    void loadNodes();
});

// =====================================================================
// #B.177 Activity column helpers
// =====================================================================

// C2 slice 2 : la variante seconds-granularity vit dans lib/format
// (`relativeTimeFine`) ; le tick réactif `now` continue de driver le repaint.
function relativeTime(iso: string | null | undefined): string {
    return relativeTimeFine(iso, now.value);
}

function isHeartbeatFresh(r: Consumer): boolean {
    // #443: presence-AUTHORITATIVE (mirrors `consumerEffectiveRunning`).
    if (r.present === true) return true;
    if (r.present === false) return false;
    if (!r.state_updated_at) return false;
    const t = Date.parse(r.state_updated_at);
    return Number.isFinite(t) && now.value - t <= OFFLINE_THRESHOLD_MS;
}

function isLiveLoop(r: Consumer): boolean {
    return !!r.state && isHeartbeatFresh(r);
}

function isMcpActive(r: Consumer): boolean {
    if (!r.last_seen_at) return false;
    const t = Date.parse(r.last_seen_at);
    return Number.isFinite(t) && now.value - t <= OFFLINE_THRESHOLD_MS;
}

type LoopMode = "loop" | "human" | "offline";
function loopMode(r: Consumer): LoopMode {
    if (isHeartbeatFresh(r)) return r.state_human ? "human" : "loop";
    return isMcpActive(r) ? "human" : "offline";
}

function shouldShowStateBadge(r: Consumer): boolean {
    return !!r.state;
}

function presenceLabel(r: Consumer): string {
    return r.state_human_word ?? (r.state_human ? "human" : "loop");
}
function presenceSeverity(r: Consumer): "danger" | "warn" | "success" {
    const w = presenceLabel(r);
    if (w === "stop") return "danger";
    // #619 — `boot` (launch-grace) tints warn like wait ; legacy `ask` rows
    // (retired by #619 collapse) kept tolerant.
    if (w === "wait" || w === "human" || w === "boot" || w === "ask") return "warn";
    return "success";
}
function activitySeverity(r: Consumer): "info" | "warn" | "secondary" {
    if (r.state === "busy") return "info";
    if (r.state === "boot") return "warn";
    return "secondary";
}
function staleBadge(r: Consumer): { label: string; severity: "warn" | "secondary" } {
    return isMcpActive(r)
        ? { label: "human", severity: "warn" }
        : { label: "offline", severity: "secondary" };
}
function loopBadgeTooltip(r: Consumer): string {
    if (!r.state) return "no claude-loop activity recorded";
    const mode = loopMode(r);
    if (mode === "offline")
        return `last heartbeat ${relativeTime(r.state_updated_at)} — loop timer likely down`;
    if (mode === "human")
        return isHeartbeatFresh(r)
            ? `human driving this loop (${r.state}) — heartbeat ${relativeTime(r.state_updated_at)}`
            : `loop not heartbeating but active via API ${relativeTime(r.last_seen_at)} — human-driven / loop stopped`;
    return `autonomous loop — ${r.state} since ${relativeTime(r.state_since)}`;
}

// =====================================================================
// #592 — declarative columns + filter (sort handled by DataList)
// =====================================================================

const columns: DataListColumn[] = [
    { key: "consumer_id", label: "Consumer id", sortable: true, defaultDir: "asc" },
    { key: "kind", label: "Kind", sortable: true, defaultDir: "asc", cellClass: "col-kind" },
    { key: "display_name", label: "Display name", sortable: true, defaultDir: "asc", cellClass: "col-display" },
    { key: "pings", label: "Pings", sortable: true, defaultDir: "desc", cellClass: "col-pings" },
    { key: "node", label: "Node", cellClass: "col-node" },
    { key: "activity", label: "Activity", sortable: true, defaultDir: "desc", cellClass: "activity-cell" },
    { key: "enabled", label: "Active", sortable: true, defaultDir: "desc", cellClass: "col-enabled" },
    { key: "_indicator", label: "", cellClass: "indicator-cell" },
];

function sortValue(r: Consumer, key: string): string | number {
    switch (key) {
        case "consumer_id": return r.consumer_id.toLowerCase();
        case "kind": return r.kind;
        case "display_name": return (r.display_name ?? "").toLowerCase();
        case "pings": return r.ping_count ?? 0;
        case "activity": return r.last_seen_at ? Date.parse(r.last_seen_at) : 0;
        case "enabled": return r.enabled ? 1 : 0;
        default: return "";
    }
}

// Filter before passing to DataList (the latter only sorts).
const visibleRows = computed<Consumer[]>(() => {
    if (!hideStale.value) return rows.value;
    const threshold = Date.now() - STALE_THRESHOLD_MS;
    return rows.value.filter((r) => {
        if (!r.last_seen_at) return false;
        return Date.parse(r.last_seen_at) >= threshold;
    });
});
</script>

<template>
    <ConsumerEditPage
        v-if="props.editConsumerId"
        :consumer-id="props.editConsumerId"
        @close="emit('close-edit')"
        @close-to-inbox="emit('close-to-inbox')"
    />
    <div v-else class="consumers-panel">
        <PanelHeader title="Consumers">
            <p class="aiball-explainer aiball-explainer--muted">
                One row per <code>consumer_id</code> the daemon has seen.
                <em>Human</em> = moderator (bypasses moderation, closes / snoozes any ticket);
                <em>agent</em> = anyone else. Click the pencil to edit, the envelope to block.
            </p>
        </PanelHeader>

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
                {{ visibleRows.length }} shown / {{ rows.length }} total
            </span>
        </section>

        <DataList
            table-class="consumers-table"
            :columns="columns"
            :rows="visibleRows"
            :row-key="(r: Consumer) => r.consumer_id"
            :row-title="(r: Consumer) => `Open ${r.consumer_id} detail`"
            :row-class="(r: Consumer) => ['dl-clickable', { 'is-blocked': !r.enabled }]"
            :get-sort-value="sortValue"
            default-sort-key="activity"
            default-sort-dir="desc"
            :loading="loading && !rows.length"
            :is-empty="!rows.length"
            @row-click="(r: Consumer) => emit('open-edit', r.consumer_id)"
        >
            <template #empty>
                <div class="aiball-empty">
                    <i class="pi pi-users" style="font-size: 1.6rem" />
                    <div>No consumers yet — anyone who posts will be added here automatically.</div>
                </div>
            </template>
            <template #cell-consumer_id="{ row }">
                <div class="consumers-cid__inner">
                    <span class="consumers-cid__text">{{ (row as Consumer).consumer_id }}</span>
                    <Tag
                        v-if="(row as Consumer).kind === 'human'"
                        value="moderator"
                        severity="success"
                        class="consumers-cid__tag"
                    />
                    <Tag
                        v-else-if="(row as Consumer).kind === 'sandbox'"
                        value="sandbox"
                        severity="warn"
                        class="consumers-cid__tag"
                    />
                    <Tag
                        v-if="(row as Consumer).remote && !nodeFor(row as Consumer)"
                        :value="(row as Consumer).last_seen_via === 'node' ? 'via node' : 'remote'"
                        severity="info"
                        class="consumers-cid__tag"
                        :title="`last seen via ${(row as Consumer).last_seen_via ?? '?'}${(row as Consumer).last_seen_ip ? ' · ' + (row as Consumer).last_seen_ip : ''}`"
                    />
                    <!-- #1435 slice 5 — multi-agent role badge (lead / crew). -->
                    <Tag
                        v-if="(row as Consumer).role"
                        :value="(row as Consumer).role ?? ''"
                        :severity="(row as Consumer).role === 'lead' ? 'success' : 'contrast'"
                        class="consumers-cid__tag"
                        :title="`multi-agent role: ${(row as Consumer).role}`"
                    />
                </div>
            </template>
            <template #cell-kind="{ row }">{{ (row as Consumer).kind }}</template>
            <template #cell-display_name="{ row }">{{ (row as Consumer).display_name ?? "" }}</template>
            <template #cell-pings="{ row }">
                <span
                    class="consumers-pings"
                    :title="`${(row as Consumer).ping_count ?? 0} ping rows in DB · ${(row as Consumer).ping_unseen ?? 0} unseen`"
                >
                    {{ (row as Consumer).ping_count ?? 0 }}<span
                        v-if="(row as Consumer).ping_unseen"
                        class="consumers-pings__unseen"
                    > ({{ (row as Consumer).ping_unseen }})</span>
                </span>
            </template>
            <template #cell-node="{ row }">
                <a
                    v-if="nodeFor(row as Consumer)"
                    :href="`/nodes/${encodeURIComponent(nodeFor(row as Consumer)!.node_id)}`"
                    class="consumers-node-link"
                    :title="`Relayed by node ${nodeFor(row as Consumer)?.label || nodeFor(row as Consumer)?.node_id}${(row as Consumer).last_seen_ip ? ' · ' + (row as Consumer).last_seen_ip : ''} — open node`"
                    @click.stop.prevent="() => { const n = nodeFor(row as Consumer); if (n) emit('open-node', n.node_id); }"
                >{{ nodeFor(row as Consumer)?.label || nodeFor(row as Consumer)?.node_id }}</a>
            </template>
            <template #cell-activity="{ row }">
                <div
                    class="activity-cell__seen"
                    :title="(row as Consumer).last_seen_at ?? 'never seen'"
                >
                    {{ relativeTime((row as Consumer).last_seen_at) }}
                </div>
                <template v-if="shouldShowStateBadge(row as Consumer)">
                    <template v-if="isHeartbeatFresh(row as Consumer)">
                        <Tag
                            :value="presenceLabel(row as Consumer)"
                            :severity="presenceSeverity(row as Consumer)"
                            :title="loopBadgeTooltip(row as Consumer)"
                            class="activity-cell__state"
                        />
                        <Tag
                            :value="(row as Consumer).state ?? ''"
                            :severity="activitySeverity(row as Consumer)"
                            :title="loopBadgeTooltip(row as Consumer)"
                            class="activity-cell__state"
                        />
                    </template>
                    <Tag
                        v-else
                        :value="staleBadge(row as Consumer).label"
                        :severity="staleBadge(row as Consumer).severity"
                        :title="loopBadgeTooltip(row as Consumer)"
                        class="activity-cell__state"
                    />
                </template>
            </template>
            <template #cell-enabled="{ row }">
                <Tag
                    :value="(row as Consumer).enabled ? 'enabled' : 'blocked'"
                    :severity="(row as Consumer).enabled ? 'success' : 'danger'"
                />
            </template>
            <template #cell-_indicator="{ row }">
                <span
                    v-if="isLiveLoop(row as Consumer)"
                    class="indicator-cell__dot"
                    :title="`Live claude-loop running as ${(row as Consumer).consumer_id} — open detail to Stop`"
                />
            </template>
        </DataList>
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
    font-size: var(--fs-lg);
    cursor: pointer;
    user-select: none;
}
.consumers-toolbar__count {
    font-size: var(--fs-sm);
    color: var(--p-text-muted-color);
}
/* Look de base via `.aiball-table`. Deltas conservés via compound
   `.aiball-table.consumers-table` (gagne sur la base) :
   - cellules centrées verticalement ;
   - hauteur de ligne épinglée pour stabiliser la grille. */
.aiball-table.consumers-table th,
.aiball-table.consumers-table td {
    vertical-align: middle;
    height: 3rem;
}
.consumers-table td:first-child {
    font-family: var(--font-mono);
    font-size: var(--fs-md);
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
    font-size: var(--fs-2xs);
    flex-shrink: 0;
}
.consumers-table .col-node {
    white-space: nowrap;
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
}
.consumers-node-link {
    color: var(--p-text-color);
    text-decoration: none;
    cursor: pointer;
}
.consumers-node-link:hover {
    text-decoration: underline;
    color: var(--p-primary-color);
}
.consumers-table tr.is-blocked {
    opacity: 0.55;
}
/* `.dl-clickable` + `.indicator-cell` + `.indicator-cell__dot` live in
   `ui/DataList.vue` shared styles. Only the consumer-specific activity
   cell deltas stay here. */
.consumers-table .activity-cell {
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

/* #B.193 mobile compaction — keep table inside viewport. */
@media (max-width: 640px) {
    .consumers-table .col-kind,
    .consumers-table .col-display,
    .consumers-table .col-node,
    .consumers-table .col-enabled {
        display: none;
    }
    .consumers-table,
    .consumers-table thead,
    .consumers-table tbody {
        display: block;
    }
    .consumers-table tr {
        display: flex;
        align-items: center;
        border-bottom: 1px solid var(--p-content-border-color);
    }
    .consumers-table th,
    .consumers-table td {
        border-bottom: none;
        padding: 0.4rem 0.35rem;
        height: auto;
    }
    .consumers-table td:first-child {
        display: block;
        flex: 1 1 0;
        min-width: 0;
        overflow: hidden;
    }
    .consumers-table .activity-cell {
        display: block;
        flex: 0 0 auto;
        min-width: 0;
        white-space: nowrap;
    }
    .consumers-table .indicator-cell {
        display: block;
        flex: 0 0 auto;
        width: auto;
        padding-right: 0.25rem;
    }
}
</style>
