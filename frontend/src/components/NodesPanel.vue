<script setup lang="ts">
// #424 — Nodes panel: lists proxy-node tokens (kind=node) with their label,
// last activity and last peer IP — each row links to the node detail page.
// Read-only list; revoke + relayed consumers live on the detail page (#452).
// The token value is never exposed — a node is keyed by a non-secret `node_id`.
import { ref, onMounted, onUnmounted } from "vue";
import { api, type NodeView } from "../lib/api";
import NodeDetailPage from "./NodeDetailPage.vue";
import DataList, { type DataListColumn } from "./ui/DataList.vue";
import PanelHeader from "./ui/PanelHeader.vue";
import StatusPill from "./ui/StatusPill.vue";
import { nodeLivenessStatus, nodeLivenessLabel } from "../lib/node-liveness";

// Set on /nodes/<id> → render the dedicated detail view. Parent (App.vue) owns
// the ref so browser back/forward works (#452, mirrors ConsumersPanel #B.193).
const props = defineProps<{
    editNodeId?: string | null;
}>();
const emit = defineEmits<{
    (e: "open-edit", nodeId: string): void;
    (e: "close-edit"): void;
    /** #458 — forwarded from NodeDetailPage: the breadcrumb's "Inbox" crumb
     *  resets BOTH the panel and the node-edit slot in one shot. */
    (e: "close-to-inbox"): void;
}>();

const nodes = ref<NodeView[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
        nodes.value = await api.listNodes();
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
}

function fmt(ts: string | null): string {
    if (!ts) return "—";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

// #502 — la pastille est dérivée de `last_used_at` + l'horloge courante.
const nowMs = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
    load();
    nowTimer = setInterval(() => { nowMs.value = Date.now(); }, 15_000);
});
onUnmounted(() => {
    if (nowTimer) clearInterval(nowTimer);
});

function liveness(lastUsedAt: string | null): "up" | "stale" | "down" {
    return nodeLivenessStatus(lastUsedAt, new Date(nowMs.value));
}
function livenessTitle(lastUsedAt: string | null): string {
    if (!lastUsedAt) return "never seen";
    const ageSec = Math.max(0, Math.round((nowMs.value - Date.parse(lastUsedAt)) / 1000));
    if (ageSec < 60) return `last activity ${ageSec}s ago`;
    if (ageSec < 3600) return `last activity ${Math.round(ageSec / 60)}min ago`;
    return `last activity ${Math.round(ageSec / 3600)}h ago`;
}

// #513 — version proxy compacte pour la liste.
type WsState = NonNullable<NodeView["ws_state"]>;
function proxyVersionShort(s: WsState): string | null {
    const v = s.node_version;
    const c = s.node_commit;
    const ver = v && v !== "(unknown)" ? v : null;
    const commit = c && c !== "(unknown)" ? c.slice(0, 8) : null;
    if (ver && commit) return `${ver} · ${commit}`;
    if (ver) return ver;
    if (commit) return commit;
    return null;
}

// #592 — declarative columns. Sort by liveness (down < stale < up) when
// status is the key, by date for activity, etc.
const columns: DataListColumn[] = [
    { key: "status", label: "Status", sortable: true, defaultDir: "asc" },
    { key: "node", label: "Node", sortable: true, defaultDir: "asc" },
    { key: "host", label: "Host", sortable: true, defaultDir: "asc" },
    { key: "last_activity", label: "Last activity", sortable: true, defaultDir: "desc" },
];

function sortValue(n: NodeView, key: string): string | number {
    switch (key) {
        // down < stale < up so asc surfaces problems first.
        case "status": {
            const order = { down: 0, stale: 1, up: 2 } as const;
            return order[liveness(n.last_used_at)];
        }
        case "node": return (n.label ?? n.node_id).toLowerCase();
        case "host": return (n.display_host ?? n.last_seen_ip ?? "").toLowerCase();
        case "last_activity": return n.last_used_at ? Date.parse(n.last_used_at) : 0;
        default: return "";
    }
}
</script>

<template>
    <NodeDetailPage
        v-if="props.editNodeId"
        :node-id="props.editNodeId"
        @close="emit('close-edit')"
        @close-to-inbox="emit('close-to-inbox')"
    />
    <div v-else class="nodes-panel">
        <PanelHeader title="Proxy nodes">
            <p class="aiball-explainer aiball-explainer--muted">
                Each row is a <strong>node token</strong> (<code>aiball auth issue --node</code>) that relays
                remote clients to this daemon. The token value is never shown — a node is addressed by its id.
            </p>
        </PanelHeader>

        <DataList
            table-class="nodes-table"
            :columns="columns"
            :rows="nodes"
            :row-key="(n: NodeView) => n.node_id"
            :row-title="(n: NodeView) => `View node ${n.label || n.node_id}${n.relayed_count ? ` — ${n.relayed_count} relayed consumer${n.relayed_count > 1 ? 's' : ''}` : ''}`"
            :row-class="() => 'dl-clickable'"
            :get-sort-value="sortValue"
            default-sort-key="last_activity"
            default-sort-dir="desc"
            :loading="loading && !nodes.length"
            :error="error"
            :is-empty="!nodes.length"
            @row-click="(n: NodeView) => emit('open-edit', n.node_id)"
        >
            <template #empty>
                <div class="aiball-empty">
                    <i class="pi pi-sitemap" style="font-size: 1.6rem" />
                    <p>No proxy nodes. Mint one on this host with <code>aiball auth issue --node</code>.</p>
                </div>
            </template>
            <template #cell-status="{ row }">
                <StatusPill
                    :status="liveness((row as NodeView).last_used_at)"
                    :label="nodeLivenessLabel(liveness((row as NodeView).last_used_at))"
                    :title="livenessTitle((row as NodeView).last_used_at)"
                />
            </template>
            <template #cell-node="{ row }">
                <span class="nodes-label">{{ (row as NodeView).label || "(unlabelled)" }}</span>
                <code class="nodes-id">{{ (row as NodeView).node_id }}</code>
                <code
                    v-if="(row as NodeView).ws_state?.connected && proxyVersionShort((row as NodeView).ws_state!)"
                    class="nodes-version"
                    :title="`proxy version (${(row as NodeView).ws_state?.node_version ?? '?'} commit ${(row as NodeView).ws_state?.node_commit ?? '?'})`"
                >{{ proxyVersionShort((row as NodeView).ws_state!) }}</code>
            </template>
            <template #cell-host="{ row }">
                <template v-if="(row as NodeView).display_host">
                    <span class="nodes-host" :title="(row as NodeView).last_seen_ip ? `peer ip ${(row as NodeView).last_seen_ip}` : undefined">
                        {{ (row as NodeView).display_host }}
                    </span>
                    <span
                        v-if="(row as NodeView).display_host_provider"
                        class="nodes-host-provider"
                        :title="`resolved by provider '${(row as NodeView).display_host_provider}'`"
                    >{{ (row as NodeView).display_host_provider }}</span>
                </template>
                <template v-else>{{ (row as NodeView).last_seen_ip ?? "—" }}</template>
            </template>
            <template #cell-last_activity="{ row }">
                <span :title="`created ${fmt((row as NodeView).created_at)}`">{{ fmt((row as NodeView).last_used_at) }}</span>
            </template>
        </DataList>
    </div>
</template>

<style scoped>
.nodes-panel { padding: 1rem; }
.nodes-label {
    font-weight: 600;
    color: var(--p-primary-color);
}
.nodes-id { display: block; font-size: 0.7rem; opacity: 0.5; }
.nodes-version {
    display: block;
    font-size: 0.7rem;
    opacity: 0.6;
    font-style: italic;
    color: var(--p-text-muted-color);
}
.nodes-host {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85rem;
}
.nodes-host-provider {
    margin-left: 0.4rem;
    padding: 0 0.35rem;
    border-radius: 0.4rem;
    background: var(--p-surface-200);
    color: var(--p-text-muted-color);
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.03rem;
    vertical-align: middle;
}
</style>
