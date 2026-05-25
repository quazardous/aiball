<script setup lang="ts">
/**
 * Dedicated detail page for a single proxy node (#452).
 *
 * Rendered by NodesPanel when the parent route is /nodes/<node_id>.
 * Shows the node's metadata (label, id, last peer IP, created/last-used)
 * and the consumers it relays — the relayed list moved off the node list
 * row and onto this page. Revoke lives here too (the node's home),
 * behind the same impact-aware confirm as before.
 */
import { ref, watch } from "vue";
import Button from "primevue/button";
import { useConfirm } from "primevue/useconfirm";
import { useToast } from "primevue/usetoast";
import { api, type NodeView } from "../lib/api";

const props = defineProps<{ nodeId: string }>();
const emit = defineEmits<{ (e: "close"): void }>();

const confirm = useConfirm();
const toast = useToast();
const loading = ref(false);
const error = ref<string | null>(null);
const node = ref<NodeView | null>(null);

async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
        // Reuse the full-list endpoint and filter client-side (a handful of
        // nodes at most) — same convention as ConsumerEditPage. Keeps the page
        // self-contained so a Ctrl-R on /nodes/<id> rehydrates it.
        const all = await api.listNodes();
        const found = all.find((n) => n.node_id === props.nodeId);
        if (!found) {
            error.value = `Node "${props.nodeId}" not found.`;
            return;
        }
        node.value = found;
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
}

watch(() => props.nodeId, load, { immediate: true });

function fmt(ts: string | null): string {
    if (!ts) return "—";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
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
</script>

<template>
    <div class="node-detail">
        <nav class="node-detail__crumbs">
            <a
                href="/nodes"
                class="node-detail__crumb-link"
                @click.prevent="emit('close')"
            >
                <i class="pi pi-arrow-left" /> Proxy nodes
            </a>
            <span class="node-detail__crumb-sep">/</span>
            <span class="node-detail__crumb-current">{{ props.nodeId }}</span>
        </nav>
        <header class="node-detail__head">
            <h2 class="node-detail__title">Node details</h2>
        </header>

        <div v-if="loading" class="aiball-empty">Loading…</div>
        <div v-else-if="error" class="aiball-empty node-detail__error">
            <i class="pi pi-exclamation-triangle" />
            {{ error }}
        </div>
        <div v-else-if="node" class="node-detail__body">
            <div class="node-detail__field">
                <label>label</label>
                <div class="node-detail__value">{{ node.label || "(unlabelled)" }}</div>
            </div>

            <div class="node-detail__field">
                <label>node id</label>
                <div class="node-detail__static">{{ node.node_id }}</div>
            </div>

            <div class="node-detail__field">
                <label>last peer IP</label>
                <div class="node-detail__value">{{ node.last_seen_ip ?? "—" }}</div>
            </div>

            <div class="node-detail__meta">
                <div><strong>created</strong> {{ fmt(node.created_at) }}</div>
                <div><strong>last activity</strong> {{ fmt(node.last_used_at) }}</div>
            </div>

            <section class="node-detail__relayed">
                <h3 class="node-detail__subtitle">
                    Relayed consumers
                    <span class="node-detail__count">({{ node.relayed_count }})</span>
                </h3>
                <p class="node-detail__hint">
                    Consumers attributed to this node by its peer IP — the clients it relays
                    to this daemon. Revoking the node cuts them until it is re-enrolled.
                </p>
                <div v-if="!node.relayed_count" class="node-detail__none">
                    No consumers attributed to this node.
                </div>
                <table v-else class="node-detail__table">
                    <thead>
                        <tr>
                            <th>Consumer</th>
                            <th>Last seen</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="c in node.relayed" :key="c.consumer_id">
                            <td><code>{{ c.consumer_id }}</code></td>
                            <td>{{ fmt(c.last_seen_at) }}</td>
                        </tr>
                    </tbody>
                </table>
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
        </div>
    </div>
</template>

<style>
.node-detail {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 40rem;
}
.node-detail__head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
}
.node-detail__crumbs {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
}
.node-detail__crumb-link {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--p-primary-color);
    text-decoration: none;
}
.node-detail__crumb-link:hover {
    text-decoration: underline;
}
.node-detail__crumb-sep {
    color: var(--p-text-muted-color);
}
.node-detail__crumb-current {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
}
.node-detail__title {
    margin: 0;
}
.node-detail__error {
    color: var(--p-red-500);
}
.node-detail__body {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    padding: 1rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.5rem;
    background: var(--p-content-background);
}
.node-detail__field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
}
.node-detail__field label {
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
}
.node-detail__value {
    font-size: 0.9rem;
}
.node-detail__static {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.9rem;
    padding: 0.4rem 0.5rem;
    background: var(--p-surface-100);
    border-radius: 0.3rem;
}
.node-detail__meta {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
    font-size: 0.82rem;
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
    font-size: 0.8rem;
    line-height: 1.35;
    color: var(--p-text-muted-color);
}
.node-detail__none {
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
}
.node-detail__table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
}
.node-detail__table th,
.node-detail__table td {
    text-align: left;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--p-surface-200, #e5e7eb);
}
.node-detail__table th {
    font-weight: 600;
    opacity: 0.7;
}
.node-detail__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.4rem;
}
</style>
