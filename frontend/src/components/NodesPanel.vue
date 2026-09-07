<script setup lang="ts">
// #424 — Nodes panel: lists proxy-node tokens (kind=node) with their label,
// last activity and last peer IP — each row links to the node detail page.
// Read-only list; revoke + relayed consumers live on the detail page (#452).
// The token value is never exposed — a node is keyed by a non-secret `node_id`.
import { computed, ref, onMounted, watch } from "vue";
import { api, type NodeEnrollment, type NodeView } from "../lib/api";
import { formatActivityAge } from "../lib/format";
import { useNowTicker } from "../lib/now-ticker";
import { useLoader } from "../lib/loader";
import Button from "primevue/button";
import { useConfirm } from "primevue/useconfirm";
import { useToast } from "primevue/usetoast";
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

const confirm = useConfirm();
const toast = useToast();
const nodes = ref<NodeView[]>([]);

// #2074 — the same route carries pairing requests, prefixed so a request id can
// never be mistaken for a node id: they are different things with different
// powers, and one of them does not exist yet.
const pairingId = computed(() =>
    props.editNodeId?.startsWith("enroll:") ? props.editNodeId.slice("enroll:".length) : null);
const pairing = ref<NodeEnrollment | null>(null);

watch(pairingId, async (id: string | null) => {
    pairing.value = null;
    if (!id) return;
    const all = await api.listNodeEnrollments().catch(() => [] as NodeEnrollment[]);
    pairing.value = all.find((e) => e.id === id) ?? null;
}, { immediate: true });

function confirmApprove(): void {
    // Double confirmation, asked for explicitly: this is the moment a
    // credential comes into existence, and the dialog names what it can do
    // rather than asking "are you sure?".
    confirm.require({
        header: "Approve this node?",
        message: `This mints a node token for "${pairing.value?.label ?? "this node"}". `
            + "A node token can act as ANY consumer on this hub. Only approve it if the code "
            + `${pairing.value?.code} is showing on the machine you are pairing.`,
        icon: "pi pi-exclamation-triangle",
        acceptLabel: "Approve and mint",
        rejectLabel: "Cancel",
        accept: () => { void decide("approve"); },
    });
}

async function decide(verdict: "approve" | "reject"): Promise<void> {
    const id = pairingId.value;
    if (!id) return;
    try {
        pairing.value = await api.decideNodeEnrollment(id, verdict);
        if (verdict === "approve") await load();
    } catch (e) {
        // A 409 means someone already decided, or it expired while the panel
        // sat open — say so instead of leaving a dead button.
        pairing.value = null;
        toast.add({ severity: "warn", summary: "Pairing request is no longer pending",
            detail: (e as Error).message, life: 8000 });
    }
}

const { loading, error, load } = useLoader(async () => {
    nodes.value = await api.listNodes();
});

function fmt(ts: string | null): string {
    if (!ts) return "—";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

// #502 — la pastille est dérivée de `last_used_at` + l'horloge courante.
const nowMs = useNowTicker(15_000);
onMounted(() => { load(); });

function liveness(lastUsedAt: string | null): "up" | "stale" | "down" {
    return nodeLivenessStatus(lastUsedAt, new Date(nowMs.value));
}
function livenessTitle(lastUsedAt: string | null): string {
    return formatActivityAge(lastUsedAt, nowMs.value);
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
    <!-- #2074 — a PAIRING REQUEST is not a node yet, so it gets its own view on
         the same route. The code is the biggest thing on screen: comparing it
         with what the node printed is the one check that matters, and the
         approve button is deliberately behind a second confirmation because it
         mints a credential that can impersonate any consumer. -->
    <div v-if="pairingId" class="nodes-panel">
        <PanelHeader title="Pair a proxy node">
            <p class="aiball-explainer aiball-explainer--muted">
                A node asked to be enrolled. Approving mints its <strong>node token</strong> —
                a credential that can act as any consumer — so check the code below
                matches the one printed on that machine before you accept.
            </p>
        </PanelHeader>
        <div v-if="pairing" class="pairing">
            <div class="pairing__code">{{ pairing.code }}</div>
            <dl class="pairing__facts">
                <dt>Calls itself</dt><dd>{{ pairing.label ?? "—" }} <span class="pairing__caveat">(chosen by the node)</span></dd>
                <dt>Coming from</dt><dd>{{ pairing.requested_ip ?? "—" }} <span class="pairing__caveat">(observed by this hub)</span></dd>
                <dt>Asked at</dt><dd>{{ new Date(pairing.created_at).toLocaleString() }}</dd>
                <dt>Status</dt><dd>{{ pairing.state }}</dd>
            </dl>
            <div v-if="pairing.state === 'pending'" class="pairing__actions">
                <Button label="Approve — mint this node's token" icon="pi pi-check" @click="confirmApprove" />
                <Button label="Refuse" icon="pi pi-times" severity="secondary" outlined @click="decide('reject')" />
            </div>
            <p v-else class="aiball-explainer aiball-explainer--muted">
                Already decided — nothing left to do here.
            </p>
        </div>
        <p v-else class="aiball-explainer aiball-explainer--muted">
            This pairing request no longer exists. It may have expired: an unattended
            request stops being a door after a few minutes.
        </p>
        <Button label="Back" icon="pi pi-arrow-left" text @click="emit('close-edit')" />
    </div>
    <NodeDetailPage
        v-else-if="props.editNodeId"
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
.nodes-id { display: block; font-size: var(--fs-2xs); opacity: 0.5; }
.nodes-version {
    display: block;
    font-size: var(--fs-2xs);
    opacity: 0.6;
    font-style: italic;
    color: var(--p-text-muted-color);
}
.nodes-host {
    font-family: var(--font-mono);
    font-size: var(--fs-md);
}
.nodes-host-provider {
    margin-left: 0.4rem;
    padding: 0 0.35rem;
    border-radius: var(--radius-md);
    background: var(--p-surface-200);
    color: var(--p-text-muted-color);
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.03rem;
    vertical-align: middle;
}

/* #610 david `ptedtq` — narrow viewports : aligne Nodes sur le pattern
   Projects (thead caché + reflow en rows aplaties + data-label inline).
   Le mobile sort chooser de DataList prend le relais pour le tri.
   `:deep()` parce que le <table> est rendu par DataList (enfant de ce
   composant scoped). */
@media (max-width: 720px) {
    :deep(.nodes-table thead) {
        display: none;
    }
    :deep(.nodes-table),
    :deep(.nodes-table tbody),
    :deep(.nodes-table tr) {
        display: block;
        width: 100%;
    }
    :deep(.nodes-table tr) {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.25rem 0.7rem;
        border: none;
        border-bottom: 1px solid var(--p-content-border-color);
        padding: 0.5rem 0.7rem;
    }
    :deep(.nodes-table td) {
        flex: 0 0 auto;
        padding: 0;
        border: none;
        text-align: left !important;
        width: auto !important;
        min-height: 0;
        display: inline-flex;
        align-items: baseline;
    }
    /* #615 david : la cellule "Node" contient label + id + version qui
       sont `display: block` côté desktop pour stacker verticalement.
       En mobile, le td devient inline-flex (par défaut ci-dessus) →
       tous les enfants s'alignent en flex items collés baseline →
       label/hash/version se touchent. Override : cette cellule passe
       en flex-direction: column pour respecter le stacking vertical. */
    :deep(.nodes-table td[data-label="Node"]) {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
    }
    :deep(.nodes-table td:not(:first-child):not(.indicator-cell)[data-label]::before) {
        content: attr(data-label) ": ";
        color: var(--p-text-muted-color);
        font-size: var(--fs-sm);
        margin-right: 0.3rem;
    }
    :deep(.nodes-table td.indicator-cell) {
        margin-left: auto;
        padding-right: 0;
    }
}

/* #2074 — the pairing view. The code dominates on purpose: comparing it with
   the node's screen is the only check standing between a stranger's request
   and a credential that can act as anyone. */
.pairing { max-width: 34rem; }
.pairing__code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 2.4rem;
    letter-spacing: .18em;
    margin: .5rem 0 1rem;
}
.pairing__facts { display: grid; grid-template-columns: auto 1fr; gap: .35rem 1rem; margin-bottom: 1.25rem; }
.pairing__facts dt { opacity: .7; }
.pairing__facts dd { margin: 0; }
.pairing__caveat { opacity: .6; font-size: .85em; }
.pairing__actions { display: flex; gap: .75rem; flex-wrap: wrap; margin-bottom: 1rem; }
</style>
