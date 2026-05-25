<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { useToast } from "primevue/usetoast";
import { useConfirm } from "primevue/useconfirm";
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
// Named `confirmDialog` (not `confirm`) so it doesn't shadow the native
// `confirm()` still used by remove() below.
const confirmDialog = useConfirm();
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

// #442: remotely stop the claude-loop running as this consumer. A proper modal
// confirm (PrimeVue ConfirmDialog, like the comment-delete flow) gates it so a
// stray click never kills a loop (david 52hq37). The work runs only on accept.
function stopLoop(consumer_id: string) {
    confirmDialog.require({
        header: "Stop loop",
        message: `Stop the claude-loop running as "${consumer_id}"? This kills its tmux session + Claude (the conversation is lost). Its state is kept — use Delete to remove it entirely.`,
        icon: "pi pi-stop-circle",
        acceptLabel: "Stop",
        rejectLabel: "Cancel",
        acceptClass: "p-button-danger",
        accept: () => { void doStopLoop(consumer_id); },
    });
}
// Actual call, after the user confirms. `delivered:false` ⇒ nothing live received
// it. The running badge clears on its own via the presence WS broadcast; reload
// shortly after as a backstop.
async function doStopLoop(consumer_id: string) {
    try {
        const r = await api.stopLoop(consumer_id);
        toast.add({
            severity: r.delivered ? "success" : "warn",
            summary: r.delivered ? `Stop sent to ${consumer_id}` : `No live loop for ${consumer_id}`,
            detail: r.delivered ? "The loop will self-terminate." : "Nothing was connected to receive it.",
            life: 5000,
        });
        setTimeout(() => void load(), 1500);
    } catch (e) {
        toast.add({
            severity: "error",
            summary: `Stop failed for ${consumer_id}`,
            detail: (e as Error).message,
            life: 6000,
        });
    }
}

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
                <th class="sortable" @click="toggleSort('activity')">
                    Activity <i :class="sortIcon('activity')" />
                </th>
                <th class="sortable col-enabled" @click="toggleSort('enabled')">
                    Active <i :class="sortIcon('enabled')" />
                </th>
                <th />
            </template>
            <template #body>
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
                            <!-- #422: remote consumer (node-relayed or TCP from a
                                 non-loopback peer). Title shows the transport + ip. -->
                            <!-- #455: node-relayed → clickable badge showing the
                                 relaying node's label, links to its detail page.
                                 Anchor wraps the Tag because @click on a PrimeVue
                                 Tag doesn't forward the native click. -->
                            <a
                                v-if="nodeFor(r)"
                                href="#"
                                class="consumers-node-link"
                                :title="`Relayed by node ${nodeFor(r)?.label || nodeFor(r)?.node_id}${r.last_seen_ip ? ' · ' + r.last_seen_ip : ''} — open node`"
                                @click.prevent="() => { const n = nodeFor(r); if (n) emit('open-node', n.node_id); }"
                            >
                                <Tag
                                    :value="`via ${nodeFor(r)?.label || 'node'}`"
                                    severity="info"
                                    class="consumers-cid__tag"
                                />
                            </a>
                            <Tag
                                v-else-if="r.remote"
                                :value="r.last_seen_via === 'node' ? 'via node' : 'remote'"
                                severity="info"
                                class="consumers-cid__tag"
                                :title="`last seen via ${r.last_seen_via ?? '?'}${r.last_seen_ip ? ' · ' + r.last_seen_ip : ''}`"
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
                    <td class="action-cell">
                        <div class="action-cell__inner">
                            <!-- #442/#443: remote hard-kill on ANY live loop
                                 (wait/busy/boot/human too — not just autonomous). -->
                            <Button
                                v-if="isLiveLoop(r)"
                                icon="pi pi-stop-circle"
                                severity="danger"
                                text
                                rounded
                                size="small"
                                :title="`Stop (hard-kill) the claude-loop running as ${r.consumer_id}`"
                                @click="stopLoop(r.consumer_id)"
                            />
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
/* #455: node-relayed badge that links to its node's detail page. */
.consumers-node-link {
    display: inline-flex;
    text-decoration: none;
    cursor: pointer;
    flex-shrink: 0;
}
.consumers-node-link:hover {
    filter: brightness(0.95);
}
.consumers-table tr.is-blocked {
    opacity: 0.55;
}
/* Use a .consumers-table-scoped selector — there's a sibling
   .action-cell rule in ProjectsPanel.vue (non-scoped styles bleed
   across components) that forces display: flex on td which breaks
   the table layout here (#B.150). Also reset min-width because that
   sibling rule pinned 14rem (224px), which on phone ate the cid cell
   down to 1 character (#B.193 "login complètement masqué"). */
.consumers-table .action-cell {
    display: table-cell;
    text-align: right;
    /* #B.177 david: "chevauchement de l'icone delete avec la barre
       scroll" — when the table overflows horizontally, the scroll
       bar sat on top of the action button. Bump the width + add
       right padding so the icon is inset away from any scrollbar
       gutter. */
    width: 4rem;
    min-width: 0;
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
       rules set display:table-cell on .activity-cell / .action-cell, which
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
    .consumers-table .action-cell {
        display: block;
        flex: 0 0 auto;
        width: auto;
        padding-right: 0.25rem;
    }
}
</style>
