<script setup lang="ts">
// #424 — Nodes panel: lists proxy-node tokens (kind=node) with their label,
// last activity and last peer IP — each row links to the node detail page.
// Read-only list; revoke + relayed consumers live on the detail page (#452).
// The token value is never exposed — a node is keyed by a non-secret `node_id`.
import { computed, ref, onMounted, watch } from "vue";
import { api, type NodeEnrollment, type NodeView, type PairingWindow } from "../lib/api";
import { formatActivityAge } from "../lib/format";
import { useNowTicker } from "../lib/now-ticker";
import { useBus } from "../lib/bus";
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

// #2074 — the enrolment switch. The public pairing route only answers while
// this is open; shut is the default, and a restart shuts it again.
const pairingWin = ref<PairingWindow | null>(null);
async function refreshPairingWindow(): Promise<void> {
    pairingWin.value = await api.getPairingWindow().catch(() => null);
}
async function togglePairingWindow(): Promise<void> {
    pairingWin.value = await api.setPairingWindow(pairingOpen.value ? "close" : "open");
}

// The window is a DEADLINE, not a number fetched once. Reading `seconds_left`
// straight from the response made the panel say "10 more min" for ten minutes
// and keep claiming the door was open long after it had shut — the snapshot was
// only true at the instant it was built. Everything below is derived from
// `open_until` against a live clock, so the countdown moves and the panel closes
// itself at zero without waiting for the next fetch.
const pairingNow = useNowTicker(1_000);
const pairingLeftSec = computed(() => {
    const until = pairingWin.value?.open_until;
    if (!until) return 0;
    const left = Math.ceil((Date.parse(until) - pairingNow.value) / 1000);
    return Number.isFinite(left) ? Math.max(0, left) : 0;
});
const pairingOpen = computed(() => pairingLeftSec.value > 0);
const pairingCountdown = computed(() => {
    const s = pairingLeftSec.value;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
});
// The duration belongs to the server, which is also what `open` will apply.
const pairingDefaultMin = computed(() =>
    Math.round((pairingWin.value?.default_seconds ?? 600) / 60));
const toast = useToast();
const nodes = ref<NodeView[]>([]);

// #2078 — a pairing request belongs on the LIST, not only in a toast. A toast
// is a notification: miss it and the request becomes unreachable, even though
// it is the one thing on this screen actively waiting on a human. So a node
// that has asked to pair shows up here straight away, in a "to confirm" state,
// and leaves the list by being approved (it becomes a real node) or refused.
const enrollments = ref<NodeEnrollment[]>([]);

/** A row is either a node, or a request to become one. Those are different
 *  things with different powers, hence a discriminant rather than a
 *  half-filled NodeView. */
type PendingRow = NodeEnrollment & { row_kind: "pending" };
type NodeRow = NodeView & { row_kind: "node" };
type Row = PendingRow | NodeRow;
function isPending(row: unknown): row is PendingRow {
    return (row as Row).row_kind === "pending";
}
/**
 * How a request ended, or that it hasn't. A finished one is still shown for a
 * while — #2079 for the expiry nobody witnessed, #2082 because refusing made
 * the row vanish with no sign of what had been done — but it is no longer a
 * door: nothing to approve, only something to know.
 *
 * Read against the live clock rather than the state the server reported, so a
 * request that runs out while the panel sits open turns grey in place instead
 * of staying falsely approvable.
 */
function outcomeOf(row: unknown): "waiting" | "expired" | "refused" | null {
    if (!isPending(row)) return null;
    if (row.state === "rejected") return "refused";
    return Date.parse(row.expires_at) <= pairingNow.value ? "expired" : "waiting";
}
/** #2085 — a node row that is a receipt rather than a node: revoked, so there
 *  is nothing left to open. */
function isRevoked(row: unknown): boolean {
    return !isPending(row) && !!(row as NodeView).revoked_at;
}
/** Finished, whichever way — a request that ended, or a node that was revoked.
 *  These are the rows shown greyed: something to know, nothing to click. */
function isDone(row: unknown): boolean {
    const o = outcomeOf(row);
    return o === "expired" || o === "refused" || isRevoked(row);
}
function asNode(row: unknown): NodeView {
    return row as NodeView;
}

const rows = computed<Row[]>(() => [
    ...enrollments.value
        // Waiting, or recently finished with nothing to show for it. An
        // APPROVED one is left out on purpose: its outcome is the node that
        // just appeared in this same list. The server decides how long each
        // kind keeps being served.
        .filter((e) => e.state === "pending" || e.state === "expired" || e.state === "rejected")
        .map((e) => ({ ...e, row_kind: "pending" as const })),
    ...nodes.value.map((n) => ({ ...n, row_kind: "node" as const })),
]);

// A request arriving — or being decided from another tab — repaints the list.
// The daemon already broadcasts it for the toast; the list hears the same thing
// rather than relying on the human still being on the page when it landed.
useBus("node.pairing", () => { void load(); });

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
        // Reload either way: approving adds a node, refusing removes a row that
        // is no longer waiting on anyone.
        await load();
    } catch (e) {
        // A 409 means someone already decided, or it expired while the panel
        // sat open — say so instead of leaving a dead button.
        pairing.value = null;
        toast.add({ severity: "warn", summary: "Pairing request is no longer pending",
            detail: (e as Error).message, life: 8000 });
    }
}

const { loading, error, load } = useLoader(async () => {
    const [ns, es] = await Promise.all([api.listNodes(), api.listNodeEnrollments()]);
    nodes.value = ns;
    enrollments.value = es;
    // #2087 — the enrolment window rides the same refresh, so opening or
    // shutting it anywhere reaches this panel too. It swallows its own errors,
    // so it can never fail the list.
    await refreshPairingWindow();
    // #2085 — and this is what makes a revocation show as revoked without a
    // reload: the daemon broadcasts on revoke, the WS relays it onto
    // `consumers.refresh`, and this panel was the one consumer surface not
    // listening. Same wiring as ConsumersPanel rather than a hand-rolled one.
}, { refreshOn: ["consumers.refresh"] });

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

function sortValue(row: Row, key: string): string | number {
    if (isPending(row)) {
        switch (key) {
            // Below `down`, so sorting by status ascending — "problems first" —
            // puts the row actually waiting on a human at the top. An expired
            // one goes past `up` instead: it is a trace, not a thing to do.
            case "status": return isDone(row) ? 3 : -1;
            case "node": return (row.label ?? row.code).toLowerCase();
            // Sort on what the column actually shows.
            case "host": return (row.claimed_host ?? row.requested_ip ?? "").toLowerCase();
            // A request is minutes old, so the default sort (newest activity
            // first) floats it up without needing a special case.
            case "last_activity": return Date.parse(row.created_at);
            default: return "";
        }
    }
    const n: NodeView = row;
    switch (key) {
        // down < stale < up so asc surfaces problems first.
        case "status": {
            // A revoked node sorts past `up`, with the expired requests: a
            // receipt is not a problem to fix.
            if (isRevoked(n)) return 3;
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
                <!-- #2081 — two lines on purpose. The hub observed one of these
                     and was told the other; on the screen where a credential is
                     about to be minted, that difference is the whole point. -->
                <dt>Says it runs on</dt>
                <dd>
                    {{ pairing.claimed_host ?? "—" }}
                    <span class="pairing__caveat">
                        (claimed by the node{{ pairing.claimed_host_provider ? `, via ${pairing.claimed_host_provider}` : "" }})
                    </span>
                </dd>
                <dt>Coming from</dt><dd>{{ pairing.requested_ip ?? "—" }} <span class="pairing__caveat">(observed by this hub)</span></dd>
                <dt>Asked at</dt><dd>{{ new Date(pairing.created_at).toLocaleString() }}</dd>
                <dt>Status</dt><dd>{{ pairing.state }}</dd>
            </dl>
            <div v-if="pairing.state === 'pending'" class="pairing__actions">
                <Button label="Approve — mint this node's token" icon="pi pi-check" @click="confirmApprove" />
                <Button label="Refuse" icon="pi pi-times" severity="secondary" outlined @click="decide('reject')" />
            </div>
            <!-- #2079 — "expired" and "decided" are not the same news: one says
                 a human answered, the other says nobody did in time. -->
            <p v-else-if="pairing.state === 'expired'" class="aiball-explainer aiball-explainer--muted">
                This request expired before anyone answered it. Run
                <code>aiball proxy pair</code> again on that machine to ask afresh.
            </p>
            <p v-else-if="pairing.state === 'rejected'" class="aiball-explainer aiball-explainer--muted">
                Refused{{ pairing.decided_by ? ` by ${pairing.decided_by}` : "" }} — no token was
                minted, and this request can't be revived. The node has to ask again.
            </p>
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
        <!-- #2074 — the enrolment switch, at the top because it decides whether
             the pairing route answers at all. Shut is the normal state: this is
             the one public write route in the API, for a gesture done a few
             times a year. -->
        <div class="pairing-window" :class="{ 'pairing-window--open': pairingOpen }">
            <div class="pairing-window__state">
                <i :class="pairingOpen ? 'pi pi-lock-open' : 'pi pi-lock'" />
                <span v-if="pairingOpen">
                    Accepting pairing requests —
                    <span class="pairing-window__left">{{ pairingCountdown }}</span> left
                    <span class="pairing-window__by">— opened by {{ pairingWin?.opened_by }}</span>
                </span>
                <span v-else>Not accepting pairing requests</span>
            </div>
            <Button
                :label="pairingOpen ? 'Close now' : `Allow pairing for ${pairingDefaultMin} min`"
                :icon="pairingOpen ? 'pi pi-lock' : 'pi pi-lock-open'"
                :severity="pairingOpen ? 'secondary' : undefined"
                :outlined="pairingOpen"
                size="small"
                @click="togglePairingWindow"
            />
        </div>
        <PanelHeader title="Proxy nodes">
            <p class="aiball-explainer aiball-explainer--muted">
                Each row is a <strong>node token</strong> (<code>aiball auth issue --node</code>) that relays
                remote clients to this daemon. The token value is never shown — a node is addressed by its id.
            </p>
        </PanelHeader>

        <DataList
            table-class="nodes-table"
            :columns="columns"
            :rows="rows"
            :row-key="(r: Row) => (isPending(r) ? `enroll:${r.id}` : r.node_id)"
            :row-title="(r: Row) => (isPending(r)
                ? ({
                    refused: `You refused this pairing request from ${r.label || 'an unnamed node'} — no token was minted`,
                    expired: `This pairing request from ${r.label || 'an unnamed node'} expired unanswered — run the pair command again on that machine`,
                    waiting: `Review the pairing request from ${r.label || 'an unnamed node'} — code ${r.code}`,
                }[outcomeOf(r) ?? 'waiting'])
                : isRevoked(r)
                    ? `Revoked${r.revoked_by ? ` by ${r.revoked_by}` : ''} — this node's token no longer exists`
                    : `View node ${r.label || r.node_id}${r.relayed_count ? ` — ${r.relayed_count} relayed consumer${r.relayed_count > 1 ? 's' : ''}` : ''}`)"
            :row-class="(r: Row) => (isPending(r)
                ? (isDone(r) ? 'dl-clickable nodes-row--done' : 'dl-clickable nodes-row--pending')
                // A revoked node has no detail page left to open, so it does not
                // pretend to be clickable.
                : isRevoked(r) ? 'nodes-row--done' : 'dl-clickable')"
            :get-sort-value="sortValue"
            default-sort-key="last_activity"
            default-sort-dir="desc"
            :loading="loading && !rows.length"
            :error="error"
            :is-empty="!rows.length"
            @row-click="(r: Row) => { if (!isRevoked(r)) emit('open-edit', isPending(r) ? `enroll:${r.id}` : r.node_id); }"
        >
            <template #empty>
                <div class="aiball-empty">
                    <i class="pi pi-sitemap" style="font-size: 1.6rem" />
                    <p>
                        No proxy nodes. Run <code>aiball proxy pair</code> on the node and approve
                        it here, or mint a token on this host with <code>aiball auth issue --node</code>.
                    </p>
                </div>
            </template>
            <template #cell-status="{ row }">
                <!-- A request has no liveness to report: it is not a node yet.
                     What it has is a human waiting to be asked. -->
                <StatusPill
                    v-if="outcomeOf(row) === 'refused'"
                    status="error"
                    label="refused"
                    title="You refused this request — no token was minted"
                />
                <StatusPill
                    v-else-if="outcomeOf(row) === 'expired'"
                    status="down"
                    label="expired"
                    title="Nobody approved it in time — run the pair command again on that machine"
                />
                <StatusPill
                    v-else-if="isPending(row)"
                    status="stale"
                    label="to confirm"
                    title="This node asked to pair — approve or refuse it"
                />
                <!-- #2085 — a revoked node reports no liveness: there is nothing
                     left to be alive. The pill is the receipt for the click. -->
                <StatusPill
                    v-else-if="isRevoked(row)"
                    status="error"
                    label="revoked"
                    :title="`Its token was destroyed ${fmt(asNode(row).revoked_at ?? null)}${asNode(row).revoked_by ? ` by ${asNode(row).revoked_by}` : ''} — the node can no longer relay`"
                />
                <StatusPill
                    v-else
                    :status="liveness(asNode(row).last_used_at)"
                    :label="nodeLivenessLabel(liveness(asNode(row).last_used_at))"
                    :title="livenessTitle(asNode(row).last_used_at)"
                />
            </template>
            <template #cell-node="{ row }">
                <template v-if="isPending(row)">
                    <span class="nodes-label">{{ row.label || "(unnamed node)" }}</span>
                    <code class="nodes-id">
                        code {{ row.code }} —
                        {{ {
                            refused: "refused, no token was minted",
                            expired: "expired, run `aiball proxy pair` again",
                            waiting: "not paired yet",
                        }[outcomeOf(row) ?? "waiting"] }}
                    </code>
                </template>
                <template v-else>
                    <span class="nodes-label">{{ asNode(row).label || "(unlabelled)" }}</span>
                    <code class="nodes-id">
                        {{ asNode(row).node_id }}{{ isRevoked(row) ? " — token destroyed" : "" }}
                    </code>
                    <code
                        v-if="asNode(row).ws_state?.connected && proxyVersionShort(asNode(row).ws_state!)"
                        class="nodes-version"
                        :title="`proxy version (${asNode(row).ws_state?.node_version ?? '?'} commit ${asNode(row).ws_state?.node_commit ?? '?'})`"
                    >{{ proxyVersionShort(asNode(row).ws_state!) }}</code>
                </template>
            </template>
            <template #cell-host="{ row }">
                <!-- #2081 — a request shows the name the machine gave for itself,
                     with the same provider chip a paired node gets, because the
                     peer IP is 127.0.0.1 whenever a local reverse proxy sits in
                     front. The chip is marked "says" and the tooltip carries the
                     IP: this is a claim by a caller that has proved nothing, and
                     it must not read like the verified host below. -->
                <template v-if="isPending(row)">
                    <span
                        class="nodes-host"
                        :title="row.claimed_host
                            ? `the machine says it is called '${row.claimed_host}' — unverified; this hub only observed the address ${row.requested_ip ?? 'unknown'}`
                            : 'the address this hub observed — a local reverse proxy makes this 127.0.0.1'"
                    >{{ row.claimed_host ?? row.requested_ip ?? "—" }}</span>
                    <span
                        v-if="row.claimed_host"
                        class="nodes-host-provider nodes-host-provider--claimed"
                        :title="`says it resolved this itself via '${row.claimed_host_provider ?? 'unknown'}'`"
                    >says {{ row.claimed_host_provider ?? "?" }}</span>
                </template>
                <template v-else-if="asNode(row).display_host">
                    <span class="nodes-host" :title="asNode(row).last_seen_ip ? `peer ip ${asNode(row).last_seen_ip}` : undefined">
                        {{ asNode(row).display_host }}
                    </span>
                    <span
                        v-if="asNode(row).display_host_provider"
                        class="nodes-host-provider"
                        :title="`resolved by provider '${asNode(row).display_host_provider}'`"
                    >{{ asNode(row).display_host_provider }}</span>
                </template>
                <template v-else>{{ asNode(row).last_seen_ip ?? "—" }}</template>
            </template>
            <template #cell-last_activity="{ row }">
                <span
                    v-if="isPending(row)"
                    :title="{
                        refused: `refused ${fmt(row.decided_at)}${row.decided_by ? ` by ${row.decided_by}` : ''}`,
                        expired: `expired ${fmt(row.expires_at)}`,
                        waiting: `expires ${fmt(row.expires_at)} — an unattended request stops being a door`,
                    }[outcomeOf(row) ?? 'waiting']"
                >asked {{ fmt(row.created_at) }}</span>
                <span
                    v-else-if="isRevoked(row)"
                    :title="`last seen ${fmt(asNode(row).last_used_at)}`"
                >revoked {{ fmt(asNode(row).revoked_at ?? null) }}</span>
                <span v-else :title="`created ${fmt(asNode(row).created_at)}`">{{ fmt(asNode(row).last_used_at) }}</span>
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
/* #2078 — a request is not a node: mark the row so the difference reads before
   a single word does. `:deep` because the row itself is rendered by DataList;
   an inset bar rather than a background fill, so it holds up whatever the theme
   paints behind it. The code stays legible — it is what the human compares with
   the screen on the other machine. */
:deep(tr.nodes-row--pending) {
    box-shadow: inset 3px 0 0 var(--p-yellow-500, #eab308);
}
:deep(tr.nodes-row--pending) .nodes-id {
    opacity: 0.85;
    font-weight: 600;
    letter-spacing: 0.04em;
}
/* #2081 — the provider chip on a REQUEST is a claim, not a resolution the hub
   made. Outlined rather than filled, so it reads differently at a glance from
   the chip a paired node earns. */
.nodes-host-provider--claimed {
    background: transparent;
    border: 1px dashed var(--p-surface-300);
    font-style: italic;
}
/* #2079/#2082 — a finished request is kept for a while: an expiry nobody
   witnessed, or a refusal whose only trace used to be the row disappearing.
   Greyed out — it is something to know, not something to act on, and it must
   not read like a row still waiting for a click. */
:deep(tr.nodes-row--done) {
    opacity: 0.5;
}
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

/* #2074 — the switch. Muted when shut (the normal state), and unmistakably
   lit when open, because an open door left open is the thing to notice. */
.pairing-window {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    padding: .6rem .9rem; margin-bottom: 1rem;
    border: 1px solid var(--p-content-border-color); border-radius: 6px;
}
.pairing-window--open {
    border-color: var(--p-orange-400);
    background: color-mix(in srgb, var(--p-orange-400) 8%, transparent);
}
.pairing-window__state { display: flex; align-items: center; gap: .5rem; }
.pairing-window__by { opacity: .7; }
/* Tabular figures so a ticking countdown doesn't jiggle the line. */
.pairing-window__left { font-variant-numeric: tabular-nums; font-weight: 600; }
</style>
