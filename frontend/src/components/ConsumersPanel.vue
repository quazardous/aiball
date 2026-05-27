<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import Tag from "primevue/tag";
import { useToast } from "primevue/usetoast";
import { api, type Consumer, type NodeView } from "../lib/api";
import { useBus } from "../lib/bus";
import ConsumerEditPage from "./ConsumerEditPage.vue";
import DataList from "./ui/DataList.vue";
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

// #B.177 / #280: how long without a state heartbeat before we render a
// loop agent as "offline". The claude-loop timer heartbeats every
// CL_INTERVAL (default 30s), so the old 60s gave only a 2-tick margin —
// a single delayed tick (slow pingsCount/pushState, daemon blip, GC)
// flickered a BUSY agent to "offline" (david #280 "marqué idle/offline
// alors que je les vois busy"). Widen to ~4× the default heartbeat so
// normal jitter never reads as offline.
const OFFLINE_THRESHOLD_MS = 120_000;

// Tick-clock so "2 min ago" updates without re-fetching the API.
const now = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;

const toast = useToast();
// #468 — `remove()` + `stopLoop()` ont migré sur la page détail consumer
// (ConsumerEditPage.vue déjà équipée). Le confirmDialog + ses imports ont
// donc disparu d'ici en même temps que les boutons.
const rows = ref<Consumer[]>([]);
const loading = ref(false);

// #455: proxy-node enrichment. A node-relayed consumer (last_seen_via='node')
// is matched to its node by peer IP (same rule as the node detail's relayed
// list), so its "via node" badge can show the node's label and link to the
// node's detail page. Best-effort: if the nodes call fails we just fall back
// to the plain "via node" tag.
const nodesByIp = ref<Map<string, { node_id: string; label: string | null }>>(new Map());
async function loadNodes(): Promise<void> {
    try {
        const nodes: NodeView[] = await api.listNodes();
        const m = new Map<string, { node_id: string; label: string | null }>();
        for (const n of nodes) if (n.last_seen_ip) m.set(n.last_seen_ip, { node_id: n.node_id, label: n.label });
        nodesByIp.value = m;
    } catch {
        // best-effort enrichment — leave the map as-is
    }
}
function nodeFor(r: Consumer): { node_id: string; label: string | null } | null {
    if (r.last_seen_via !== "node" || !r.last_seen_ip) return null;
    return nodesByIp.value.get(r.last_seen_ip) ?? null;
}

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

// #443: refetch live when a loop's presence flips. The daemon broadcasts
// `consumer_changed` on SSE open/close (#395) + every heartbeat; the WS relay
// turns it into `projects.refresh` on the bus. This makes a killed loop drop its
// `loop` badge + Stop button within the grace (~6s) instead of waiting for the
// 30s poll below (which stays as a backstop).
useBus("projects.refresh", () => { void load(); });

onMounted(() => {
    load();
    void loadNodes();
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

function isHeartbeatFresh(r: Consumer): boolean {
    // #443: presence-AUTHORITATIVE (mirrors the server's
    // `consumerEffectiveRunning`). A live SSE (#395) reads fresh, a killed loop
    // reads stale within the grace (~6s) instead of lingering the full 120s
    // heartbeat window. The window survives only as the bridge for a consumer
    // never seen via SSE this session (present null — e.g. just after a restart).
    if (r.present === true) return true;
    if (r.present === false) return false;
    if (!r.state_updated_at) return false;
    const t = Date.parse(r.state_updated_at);
    return Number.isFinite(t) && now.value - t <= OFFLINE_THRESHOLD_MS;
}

/**
 * #443: a live claude-loop agent → show the remote hard-kill (Stop) button.
 * Gated on PRESENCE (is it live?), NOT on `loopMode === 'loop'`: david could not
 * kill a freshly-relaunched loop stuck in wait/busy/boot/human (q2tqqe) because
 * the old gate required an autonomous-`loop` presence word. The hard-kill (#442)
 * exists precisely for a stuck/driven loop and is already behind a confirm modal,
 * so ANY live loop is stoppable. Excludes humans (state=null) and dead/offline
 * loops (presence false ⇒ heartbeat stale).
 */
function isLiveLoop(r: Consumer): boolean {
    return !!r.state && isHeartbeatFresh(r);
}

function isMcpActive(r: Consumer): boolean {
    if (!r.last_seen_at) return false;
    const t = Date.parse(r.last_seen_at);
    return Number.isFinite(t) && now.value - t <= OFFLINE_THRESHOLD_MS;
}

/**
 * #280 david "loop vs stop/human": the badge mixed two orthogonal axes.
 * Split them — `loopMode` answers WHO is driving (autonomous loop / a
 * human / nobody), independent of the busy/idle ACTIVITY:
 *   - heartbeat fresh + live human flag → `human` (a human is driving the
 *     loop right now — typing / within user-grace);
 *   - heartbeat fresh, no human flag    → `loop` (autonomous);
 *   - heartbeat stale but still calling the API → `human` (loop stopped /
 *     human took over — agent alive without an auto-loop heartbeat);
 *   - heartbeat stale AND API silent    → `offline` (truly gone).
 * This is what kills the false "offline while I see it busy": a manually
 * driven (or stale-but-active) agent now reads `human`, not `offline`.
 */
type LoopMode = "loop" | "human" | "offline";
function loopMode(r: Consumer): LoopMode {
    if (isHeartbeatFresh(r)) return r.state_human ? "human" : "loop";
    return isMcpActive(r) ? "human" : "offline";
}

/** Show the badge for any consumer that has ever reported a loop state
 *  (humans / non-loop agents have state=null → no badge). */
function shouldShowStateBadge(r: Consumer): boolean {
    return !!r.state;
}

// #310: mirror the tmux bar's TWO chips — a presence tag (stop/wait/loop) +
// an activity tag (idle/busy/boot), with the same colour mapping — when the
// heartbeat is fresh. When stale, fall back to a single offline / stale-active
// badge (the per-chip detail is no longer meaningful once the timer is silent).
function presenceLabel(r: Consumer): string {
    // Prefer the 3-state word (#310); fall back to the legacy binary flag for
    // loops still on the pre-#310 timer (word null) so the badge never breaks.
    return r.state_human_word ?? (r.state_human ? "human" : "loop");
}
function presenceSeverity(r: Consumer): "danger" | "warn" | "success" {
    const w = presenceLabel(r);
    if (w === "stop") return "danger";                 // red — human typing
    // #426: `ask` (ASK-grace) grouped with the grace states here — the web badge
    // is coarser than the tmux bar, which paints `ask` a distinct orange.
    if (w === "wait" || w === "human" || w === "ask") return "warn"; // yellow — frozen / present / ask-grace
    return "success";                                  // green — autonomous loop
}
function activitySeverity(r: Consumer): "info" | "warn" | "secondary" {
    if (r.state === "busy") return "info";             // electric blue — matches tmux bar
    if (r.state === "boot") return "warn";             // yellow
    return "secondary";                                // idle = gray
}
function staleBadge(r: Consumer): { label: string; severity: "warn" | "secondary" } {
    // heartbeat stale → loop timer silent. MCP-active ⇒ human-driven, else gone.
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
                {{ sortedRows.length }} shown / {{ rows.length }} total
            </span>
        </section>

        <DataList
            table-class="consumers-table"
            :loading="loading && !rows.length"
            :is-empty="!rows.length"
        >
            <template #empty>
                <div class="aiball-empty">
                    <i class="pi pi-users" style="font-size: 1.6rem" />
                    <div>No consumers yet — anyone who posts will be added here automatically.</div>
                </div>
            </template>
            <template #head>
                <th class="sortable" @click="toggleSort('consumer_id')">
                    Consumer id <i :class="sortIcon('consumer_id')" />
                </th>
                <th class="sortable col-kind" @click="toggleSort('kind')">
                    Kind <i :class="sortIcon('kind')" />
                </th>
                <th class="sortable col-display" @click="toggleSort('display_name')">
                    Display name <i :class="sortIcon('display_name')" />
                </th>
                <!-- #455 (david `q76ywq`) — colonne Node dédiée plutôt qu'un
                     badge "via node" inline dans la cellule consumer id. -->
                <th class="col-node">Node</th>
                <th class="sortable" @click="toggleSort('activity')">
                    Activity <i :class="sortIcon('activity')" />
                </th>
                <th class="sortable col-enabled" @click="toggleSort('enabled')">
                    Active <i :class="sortIcon('enabled')" />
                </th>
                <th />
            </template>
            <template #body>
                <tr
                    v-for="r in sortedRows"
                    :key="r.consumer_id"
                    class="consumers-row"
                    :class="{ 'is-blocked': !r.enabled }"
                    :title="`Open ${r.consumer_id} detail`"
                    @click="emit('open-edit', r.consumer_id)"
                >
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
                            <!-- #455 (david `q76ywq`) — la mention "node" est
                                 passée dans sa propre colonne ci-dessous. Le
                                 Tag "remote" inline reste pour les non-node
                                 (TCP depuis un peer non-loopback, signal
                                 distinct). -->
                            <Tag
                                v-if="r.remote && !nodeFor(r)"
                                :value="r.last_seen_via === 'node' ? 'via node' : 'remote'"
                                severity="info"
                                class="consumers-cid__tag"
                                :title="`last seen via ${r.last_seen_via ?? '?'}${r.last_seen_ip ? ' · ' + r.last_seen_ip : ''}`"
                            />
                        </div>
                    </td>
                    <td class="col-kind">{{ r.kind }}</td>
                    <td class="col-display">{{ r.display_name ?? "" }}</td>
                    <!-- #455 (david `q76ywq`) — colonne Node dédiée : label
                         cliquable vers /nodes/<id> quand relayé, vide sinon. -->
                    <td class="col-node">
                        <a
                            v-if="nodeFor(r)"
                            :href="`/nodes/${encodeURIComponent(nodeFor(r)!.node_id)}`"
                            class="consumers-node-link"
                            :title="`Relayed by node ${nodeFor(r)?.label || nodeFor(r)?.node_id}${r.last_seen_ip ? ' · ' + r.last_seen_ip : ''} — open node`"
                            @click.stop.prevent="() => { const n = nodeFor(r); if (n) emit('open-node', n.node_id); }"
                        >{{ nodeFor(r)?.label || nodeFor(r)?.node_id }}</a>
                    </td>
                    <td class="activity-cell">
                        <div
                            class="activity-cell__seen"
                            :title="r.last_seen_at ?? 'never seen'"
                        >
                            {{ relativeTime(r.last_seen_at) }}
                        </div>
                        <template v-if="shouldShowStateBadge(r)">
                            <!-- #310: fresh heartbeat → presence (stop/wait/loop)
                                 + activity (idle/busy/boot), same vocab+colours as
                                 the tmux bar. Stale → single offline/stale badge. -->
                            <template v-if="isHeartbeatFresh(r)">
                                <Tag
                                    :value="presenceLabel(r)"
                                    :severity="presenceSeverity(r)"
                                    :title="loopBadgeTooltip(r)"
                                    class="activity-cell__state"
                                />
                                <Tag
                                    :value="r.state ?? ''"
                                    :severity="activitySeverity(r)"
                                    :title="loopBadgeTooltip(r)"
                                    class="activity-cell__state"
                                />
                            </template>
                            <Tag
                                v-else
                                :value="staleBadge(r).label"
                                :severity="staleBadge(r).severity"
                                :title="loopBadgeTooltip(r)"
                                class="activity-cell__state"
                            />
                        </template>
                    </td>
                    <td class="col-enabled">
                        <Tag
                            :value="r.enabled ? 'enabled' : 'blocked'"
                            :severity="r.enabled ? 'success' : 'danger'"
                        />
                    </td>
                    <!-- #468 david : action icons (pencil + trash + stop) retirés
                         des rows. La row entière est cliquable (handler sur <tr>
                         ci-dessus) ; Edit / Delete / Stop vivent maintenant sur
                         la page détail consumer. On garde un INDICATEUR pur
                         (point rouge) pour signaler "loop live" — read-only,
                         pas un bouton. -->
                    <td class="indicator-cell">
                        <span
                            v-if="isLiveLoop(r)"
                            class="indicator-cell__dot"
                            :title="`Live claude-loop running as ${r.consumer_id} — open detail to Stop`"
                        />
                    </td>
                </tr>
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
    font-size: 0.9rem;
    cursor: pointer;
    user-select: none;
}
.consumers-toolbar__count {
    font-size: 0.82rem;
    color: var(--p-text-muted-color);
}
/* Look de base (width/border-collapse/padding/border/th) → `.aiball-table`
   (style.css). Deltas conservés via compound `.aiball-table.consumers-table`
   (gagne sur la base quel que soit l'ordre de chargement) :
   - cellules centrées verticalement (Select/Button d'intrinsèques variables) ;
   - hauteur de ligne épinglée pour que les composants PrimeVue de hauteurs
     légèrement différentes ne fassent pas vibrer la grille entre lignes. */
.aiball-table.consumers-table th,
.aiball-table.consumers-table td {
    vertical-align: middle;
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
/* #455 (david `q76ywq`) — colonne Node : label cliquable, style cohérent
   avec les autres liens cliquables (consumer chip dans ProjectDetailPage). */
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
/* #468 david : la row entière est cliquable → consumer detail. Le
   curseur + un hover discret signalent l'affordance sans la rendre
   visuellement bruyante. */
.consumers-table tr.consumers-row {
    cursor: pointer;
}
.consumers-table tr.consumers-row:hover {
    background: var(--p-surface-50);
}
/* #468 david : la cellule d'action (pencil + trash + stop) devient un
   indicator-cell read-only avec un point rouge si un loop est live.
   Largeur minimale pour stabiliser l'alignement de la table. */
.consumers-table .indicator-cell {
    display: table-cell;
    text-align: right;
    width: 2rem;
    min-width: 0;
    padding-right: 0.75rem;
    vertical-align: middle;
}
/* #507 david : la pastille signale "live" (consumer présent), pas "stop" —
   couleur verte plus parlante (rouge faisait croire à une erreur). L'action
   "Stop" reste accessible via le row click → page détail. */
.consumers-table .indicator-cell__dot {
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--p-green-500);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--p-green-500) 25%, transparent);
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
/* #B.193 mobile compaction — keep table inside viewport, scroll as a last
   resort if a long consumer_id still overflows. Wrap (.aiball-table-wrap,
   overflow-x:auto) is provided by <DataList>.
   Phone-sized: drop the redundant columns. `kind` is already shown as
   an inline tag next to the consumer id (moderator/sandbox); `display
   name` is secondary and lives on the edit page; `enabled` is implicit
   from `tr.is-blocked` row dimming. Tighter paddings + drop the
   pinned height + min-width so rows stack without horizontal overflow. */
@media (max-width: 640px) {
    .consumers-table .col-kind,
    .consumers-table .col-display,
    .consumers-table .col-node,
    .consumers-table .col-enabled {
        display: none;
    }
    /* Drop table layout in favor of flex per row — width:99%/1%/1%
       on table cells didn't pack tight enough (consumer_id cell took
       its full 99% even when content was only "aiball-dev", leaving
       a big in-cell gap before Activity). With flex, the cid grows
       and the other two shrink to their intrinsic content, packed
       left-to-right with zero slack. */
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
    /* Force display:block on cells so the flex tr can size them — desktop
       rules set display:table-cell on .activity-cell / .indicator-cell, which
       kept the cid cell from actually growing under flex: 1 1 0 (#B.193:
       "login complètement masqué par le label modérateur"). Specificity
       must match the desktop rules (0,2,0) so the @media override wins. */
    .consumers-table .consumers-cid {
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
