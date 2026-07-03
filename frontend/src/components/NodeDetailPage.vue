<script setup lang="ts">
/**
 * Dedicated detail page for a single proxy node (#452).
 *
 * Rendered by NodesPanel when the parent route is /nodes/<node_id>.
 * Shows the node's metadata (label, id, last peer IP, created/last-used)
 * and the consumers it relays — the relayed list moved off the node list
 * row and onto this page. Revoke lives here too (the node's home),
 * behind the same impact-aware confirm as before.
 *
 * #458 — wraps <AdminDetailLayout> (3-niveaux : App.vue → AdminDetailLayout →
 * cette page). La page ne pose plus son breadcrumb, sa largeur, ni sa carte
 * de corps — c'est le layout qui le fait, identique à toutes les pages
 * détail form-style.
 */
import { ref, watch } from "vue";
import Button from "primevue/button";
import { useConfirm } from "primevue/useconfirm";
import { useToast } from "primevue/usetoast";
import { api, type NodeView } from "../lib/api";
import { formatActivityAge } from "../lib/format";
import { useNowTicker } from "../lib/now-ticker";
import { useLoader } from "../lib/loader";
import DataList, { type DataListColumn } from "./ui/DataList.vue";
import FieldRow from "./ui/FieldRow.vue";
import AdminDetailLayout from "./ui/AdminDetailLayout.vue";
import AsyncState from "./ui/AsyncState.vue";
import SectionHeader from "./ui/SectionHeader.vue";
import StatusPill from "./ui/StatusPill.vue";
import { nodeLivenessStatus, nodeLivenessLabel } from "../lib/node-liveness";

const props = defineProps<{ nodeId: string }>();
const emit = defineEmits<{
    (e: "close"): void;
    (e: "close-to-inbox"): void;
}>();

const confirm = useConfirm();
const toast = useToast();
const node = ref<NodeView | null>(null);

const { loading, error, load } = useLoader(async () => {
    // Reuse the full-list endpoint and filter client-side (a handful of
    // nodes at most) — same convention as ConsumerEditPage. Keeps the page
    // self-contained so a Ctrl-R on /nodes/<id> rehydrates it.
    const all = await api.listNodes();
    const found = all.find((n) => n.node_id === props.nodeId);
    if (!found) throw new Error(`Node "${props.nodeId}" not found.`);
    node.value = found;
});

watch(() => props.nodeId, load, { immediate: true });

function fmt(ts: string | null): string {
    if (!ts) return "—";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

// #502 — pastille liveness : recompute toutes les 15s pour que la couleur
// vieillisse sans Ctrl-R (cf. NodesPanel — même pattern).
const nowMs = useNowTicker(15_000);
function liveness(lastUsedAt: string | null): "up" | "stale" | "down" {
    return nodeLivenessStatus(lastUsedAt, new Date(nowMs.value));
}
function livenessTitle(lastUsedAt: string | null): string {
    return formatActivityAge(lastUsedAt, nowMs.value);
}

// #510 — pastille dédiée au canal WS reverse. Connecté + silence < 30s = up
// (ping interval = 25s côté daemon, on attend une frame tous les 25s) ; OPEN
// mais silence > 30s = stale (warning) ; disconnected = down.
type WsState = NonNullable<NodeView["ws_state"]>;
function wsPillStatus(s: WsState): "up" | "stale" | "down" {
    if (!s.connected) return "down";
    if (s.silent_for_sec !== null && s.silent_for_sec > 30) return "stale";
    return "up";
}
function wsPillLabel(s: WsState): string {
    if (!s.connected) return "disconnected";
    if (s.silent_for_sec !== null && s.silent_for_sec > 30) return "silent";
    return "connected";
}
function wsPillTitle(s: WsState): string {
    if (!s.connected) return "no active /ws/proxy-node connection";
    if (s.last_frame_at) {
        const sec = s.silent_for_sec ?? 0;
        if (sec < 60) return `last frame ${sec}s ago (ping interval 25s)`;
        return `last frame ${Math.round(sec / 60)}min ago — silent (anomaly)`;
    }
    return "connected (no frame timestamp)";
}

// #513 — formate la version proxy : "v0.9.0 · abc1234" (commit short).
// Tolère version manquante (juste le commit) ou commit manquant (juste la
// version), pour ne jamais afficher "null" / chaîne vide.
function formatProxyVersion(s: WsState): string {
    const v = s.node_version;
    const c = s.node_commit;
    const ver = v && v !== "(unknown)" ? v : null;
    const commit = c && c !== "(unknown)" ? c.slice(0, 8) : null;
    if (ver && commit) return `${ver} · ${commit}`;
    if (ver) return ver;
    if (commit) return commit;
    return "(unknown)";
}

// #433: confirm before revoking (destructive — cuts the node + every consumer
// it relays). On success we leave the detail page (the node no longer exists).
function revoke(): void {
    const n = node.value;
    if (!n) return;
    const label = n.label || n.node_id;
    const relayed = n.relayed_count
        ? ` ${n.relayed_count} relayed consumer${n.relayed_count > 1 ? "s" : ""} will lose access until the node is re-enrolled.`
        : "";
    confirm.require({
        header: "Revoke node",
        message: `Revoke node "${label}"? The proxy will no longer relay to this daemon.${relayed}`,
        icon: "pi pi-exclamation-triangle",
        acceptLabel: "Revoke",
        rejectLabel: "Cancel",
        acceptClass: "p-button-danger",
        accept: () => { void doRevoke(n); },
    });
}

async function doRevoke(n: NodeView): Promise<void> {
    try {
        await api.revokeNode(n.node_id);
        toast.add({ severity: "success", summary: `Revoked ${n.label || n.node_id}`, life: 3000 });
        emit("close");
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Revoke failed",
            detail: e instanceof Error ? e.message : String(e),
            life: 6000,
        });
    }
}

// #592 — declarative columns for the relayed-consumers list.
const relayedColumns: DataListColumn[] = [
    { key: "consumer_id", label: "Consumer", sortable: true, defaultDir: "asc" },
    { key: "last_seen_at", label: "Last seen", sortable: true, defaultDir: "desc" },
];

interface RelayedRow { consumer_id: string; last_seen_at: string | null }
function relayedSortValue(c: RelayedRow, key: string): string | number {
    if (key === "last_seen_at") return c.last_seen_at ? Date.parse(c.last_seen_at) : 0;
    return c.consumer_id.toLowerCase();
}
</script>

<template>
    <AdminDetailLayout
        :crumbs="[{ label: 'Inbox', href: '/' }, { label: 'Proxy nodes', href: '/nodes' }]"
        :current="props.nodeId"
        title="Node details"
        @close-to-inbox="emit('close-to-inbox')"
        @close-to-list="emit('close')"
    >
        <AsyncState :loading="loading">
            <div v-if="error" class="aiball-empty node-detail__error">
                <i class="pi pi-exclamation-triangle" />
                {{ error }}
            </div>
            <template v-else-if="node">
                <FieldRow label="status">
                    <StatusPill
                        :status="liveness(node.last_used_at)"
                        :label="nodeLivenessLabel(liveness(node.last_used_at))"
                        :title="livenessTitle(node.last_used_at)"
                    />
                </FieldRow>
                <!-- #510 — état du canal WS reverse (/ws/proxy-node) :
                     connected = WS OPEN ; disconnected = pas dans la map / CLOSED.
                     Affiche aussi la dernière frame reçue (silence trop long =
                     anomalie même si OPEN). -->
                <FieldRow v-if="node.ws_state" label="ws reverse">
                    <StatusPill
                        :status="wsPillStatus(node.ws_state)"
                        :label="wsPillLabel(node.ws_state)"
                        :title="wsPillTitle(node.ws_state)"
                    />
                </FieldRow>
                <!-- #513 — version + commit reportés par le proxy au hello WS.
                     Seulement visible quand le node est connecté (avant ça les
                     champs sont null). -->
                <FieldRow v-if="node.ws_state?.connected && (node.ws_state.node_version || node.ws_state.node_commit)" label="proxy version">
                    <span class="aiball-mono">{{ formatProxyVersion(node.ws_state) }}</span>
                </FieldRow>
                <FieldRow label="label">{{ node.label || "(unlabelled)" }}</FieldRow>
                <FieldRow label="node id"><span class="aiball-mono">{{ node.node_id }}</span></FieldRow>
                <!-- #524 : display_host résolu côté node par sa provider chain
                     (tailscale → hostname → …). NULL pour les nodes legacy ou
                     jamais connectés en WS — on cache la row alors plutôt que
                     d'afficher "—". -->
                <FieldRow v-if="node.display_host" label="host">
                    <span class="aiball-mono">{{ node.display_host }}</span>
                    <span v-if="node.display_host_provider" class="node-host-provider">via {{ node.display_host_provider }}</span>
                </FieldRow>
                <FieldRow label="last peer IP">{{ node.last_seen_ip ?? "—" }}</FieldRow>

                <div class="node-detail__meta">
                    <div><strong>created</strong> {{ fmt(node.created_at) }}</div>
                    <div><strong>last activity</strong> {{ fmt(node.last_used_at) }}</div>
                </div>

                <section class="node-detail__relayed">
                    <SectionHeader>
                        <template #title>
                            Relayed consumers
                            <span class="node-detail__count">({{ node.relayed_count }})</span>
                        </template>
                        Consumers attributed to this node by its peer IP — the clients it relays
                        to this daemon. Revoking the node cuts them until it is re-enrolled.
                    </SectionHeader>
                    <DataList
                        :columns="relayedColumns"
                        :rows="node.relayed ?? []"
                        :row-key="(c: RelayedRow) => c.consumer_id"
                        :get-sort-value="relayedSortValue"
                        :is-empty="!node.relayed_count"
                    >
                        <template #empty>
                            <div class="node-detail__none">No consumers attributed to this node.</div>
                        </template>
                        <template #cell-consumer_id="{ row }">
                            <!-- #460 — chip cliquable vers la page consumer détail. -->
                            <a
                                :href="`/consumers/${encodeURIComponent((row as RelayedRow).consumer_id)}`"
                                class="aiball-mono node-detail__relayed-link"
                                :title="`Open consumer details for ${(row as RelayedRow).consumer_id}`"
                            >{{ (row as RelayedRow).consumer_id }}</a>
                        </template>
                        <template #cell-last_seen_at="{ row }">{{ fmt((row as RelayedRow).last_seen_at) }}</template>
                    </DataList>
                </section>

                <div class="node-detail__actions">
                    <Button
                        label="Revoke"
                        icon="pi pi-ban"
                        severity="danger"
                        size="small"
                        @click="revoke"
                    />
                </div>
            </template>
        </AsyncState>
    </AdminDetailLayout>
</template>

<style>
/* Layout (largeur + carte) → `<AdminDetailLayout>` (#458). */
/* En-tête (breadcrumb + titre) → bricks internes du layout. */
.node-detail__error {
    color: var(--p-red-500);
}
/* Champs read-only → <FieldRow> / `.aiball-field-row*` + `.aiball-mono`
   (style.css). */
.node-detail__meta {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
    font-size: var(--fs-sm);
    color: var(--p-text-muted-color);
}
.node-detail__subtitle {
    margin: 0 0 0.2rem;
    font-size: 1rem;
}
.node-detail__count {
    font-weight: 400;
    color: var(--p-text-muted-color);
}
.node-detail__hint {
    margin: 0 0 0.6rem;
    font-size: var(--fs-sm);
    line-height: 1.35;
    color: var(--p-text-muted-color);
}
.node-detail__none {
    font-size: var(--fs-md);
    color: var(--p-text-muted-color);
}
/* #460 — link styling for the relayed consumer chip (still mono, hover = primary). */
.node-detail__relayed-link { color: var(--p-text-color); text-decoration: none; }
.node-detail__relayed-link:hover { text-decoration: underline; color: var(--p-primary-color); }
.node-detail__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.4rem;
}
/* #524 : provider chip à côté du display_host. */
.node-host-provider {
    margin-left: 0.5rem;
    padding: 0 0.35rem;
    border-radius: var(--radius-md);
    background: var(--p-surface-200);
    color: var(--p-text-muted-color);
    font-size: var(--fs-2xs);
    text-transform: lowercase;
}
</style>
