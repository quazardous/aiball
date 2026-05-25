<script setup lang="ts">
// #424 — Nodes panel: lists proxy-node tokens (kind=node) with their label,
// last activity and last peer IP — each row links to the node detail page.
// Read-only list; revoke + relayed consumers live on the detail page (#452).
// The token value is never exposed — a node is keyed by a non-secret `node_id`.
import { ref, onMounted } from "vue";
import { api, type NodeView } from "../lib/api";
import NodeDetailPage from "./NodeDetailPage.vue";
import DataList from "./ui/DataList.vue";
import PanelHeader from "./ui/PanelHeader.vue";

// Set on /nodes/<id> → render the dedicated detail view. Parent (App.vue) owns
// the ref so browser back/forward works (#452, mirrors ConsumersPanel #B.193).
const props = defineProps<{
    editNodeId?: string | null;
}>();
const emit = defineEmits<{
    (e: "open-edit", nodeId: string): void;
    (e: "close-edit"): void;
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

onMounted(load);
</script>

<template>
    <NodeDetailPage
        v-if="props.editNodeId"
        :node-id="props.editNodeId"
        @close="emit('close-edit')"
    />
    <div v-else class="nodes-panel">
        <PanelHeader title="Proxy nodes">
            <p class="aiball-explainer aiball-explainer--muted">
                Each row is a <strong>node token</strong> (<code>aiball auth issue --node</code>) that relays
                remote clients to this daemon. The token value is never shown — a node is addressed by its id.
            </p>
        </PanelHeader>

        <DataList :loading="loading && !nodes.length" :error="error" :is-empty="!nodes.length">
            <template #empty>
                <div class="aiball-empty">
                    <i class="pi pi-sitemap" style="font-size: 1.6rem" />
                    <p>No proxy nodes. Mint one on this host with <code>aiball auth issue --node</code>.</p>
                </div>
            </template>
            <template #head>
                <th>Node</th>
                <th>Last IP</th>
                <th>Last activity</th>
            </template>
            <template #body>
                <tr v-for="n in nodes" :key="n.node_id">
                    <td>
                        <a
                            :href="`/nodes/${encodeURIComponent(n.node_id)}`"
                            class="nodes-label-link"
                            :title="`View node details${n.relayed_count ? ` — ${n.relayed_count} relayed consumer${n.relayed_count > 1 ? 's' : ''}` : ''}`"
                            @click.prevent="emit('open-edit', n.node_id)"
                        >{{ n.label || "(unlabelled)" }}</a>
                        <code class="nodes-id">{{ n.node_id }}</code>
                    </td>
                    <td>{{ n.last_seen_ip ?? "—" }}</td>
                    <td :title="`created ${fmt(n.created_at)}`">{{ fmt(n.last_used_at) }}</td>
                </tr>
            </template>
        </DataList>
    </div>
</template>

<style scoped>
.nodes-panel { padding: 1rem; }
.nodes-label-link {
    font-weight: 600;
    color: var(--p-primary-color);
    text-decoration: none;
    cursor: pointer;
}
.nodes-label-link:hover { text-decoration: underline; }
.nodes-id { display: block; font-size: 0.7rem; opacity: 0.5; }
</style>
