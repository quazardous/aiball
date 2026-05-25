<script setup lang="ts">
// #424 — Nodes panel: lists proxy-node tokens (kind=node) with their label,
// last activity, last peer IP, and the consumers each relays. Read + revoke
// (moderator-only API). The token value is never exposed — a node is keyed by a
// non-secret `node_id`.
import { ref, onMounted } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { useConfirm } from "primevue/useconfirm";
import { api, type NodeView } from "../lib/api";

const confirm = useConfirm();
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

// #433: confirm before revoking (destructive — cuts the node + every consumer
// it relays). Uses the app's in-app PrimeVue confirm dialog (global
// <ConfirmDialog/> in App.vue), not the native window.confirm, for a consistent
// look and an impact-aware message.
function revoke(n: NodeView): void {
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
        await load();
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    }
}

function fmt(ts: string | null): string {
    if (!ts) return "—";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

onMounted(load);
</script>

<template>
    <div class="nodes-panel">
        <header class="rules-explainer-block">
            <h2>Proxy nodes</h2>
            <p class="rules-explainer rules-explainer--muted">
                Each row is a <strong>node token</strong> (<code>aiball auth issue --node</code>) that relays
                remote clients to this daemon. The token value is never shown — a node is addressed by its id.
            </p>
        </header>

        <div v-if="loading && !nodes.length" class="aiball-empty">Loading…</div>
        <div v-else-if="error" class="aiball-empty">{{ error }}</div>
        <div v-else-if="!nodes.length" class="aiball-empty">
            <i class="pi pi-sitemap" style="font-size: 1.6rem" />
            <p>No proxy nodes. Mint one on this host with <code>aiball auth issue --node</code>.</p>
        </div>
        <div v-else class="nodes-table-wrap">
            <table class="nodes-table">
                <thead>
                    <tr>
                        <th>Node</th>
                        <th>Last IP</th>
                        <th>Last activity</th>
                        <th>Relayed consumers</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="n in nodes" :key="n.node_id">
                        <td>
                            <span class="nodes-label">{{ n.label || "(unlabelled)" }}</span>
                            <code class="nodes-id">{{ n.node_id }}</code>
                        </td>
                        <td>{{ n.last_seen_ip ?? "—" }}</td>
                        <td :title="`created ${fmt(n.created_at)}`">{{ fmt(n.last_used_at) }}</td>
                        <td>
                            <span v-if="!n.relayed_count" class="nodes-muted">none</span>
                            <span v-else>
                                <Tag
                                    v-for="c in n.relayed"
                                    :key="c.consumer_id"
                                    :value="c.consumer_id"
                                    severity="info"
                                    class="nodes-consumer-tag"
                                />
                            </span>
                        </td>
                        <td>
                            <Button label="Revoke" severity="danger" text size="small" @click="revoke(n)" />
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>

<style scoped>
.nodes-panel { padding: 1rem; }
.nodes-table-wrap { overflow-x: auto; }
.nodes-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
.nodes-table th, .nodes-table td {
    text-align: left;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--p-surface-200, #e5e7eb);
    vertical-align: top;
}
.nodes-table th { font-weight: 600; opacity: 0.7; }
.nodes-label { font-weight: 600; }
.nodes-id { display: block; font-size: 0.7rem; opacity: 0.5; }
.nodes-muted { opacity: 0.5; }
.nodes-consumer-tag { margin: 0 0.2rem 0.2rem 0; }
</style>
