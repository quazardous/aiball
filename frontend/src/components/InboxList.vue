<script setup lang="ts">
import Tag from "primevue/tag";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import { type InboxRow, type SearchHit } from "../lib/api";
import { estTokenEffort, formatTokens, relativeTime, snippetOf, titleOf, tokenBreakdownTitle } from "../lib/format";
import { attentionOf, lifecycleStage } from "../lib/ticket-state";
import { formatTicketRef } from "../lib/formatting";
import {
    INTENT_SEVERITY,
    PRIORITY_COLOR_VAR,
    LIFECYCLE_ICONS,
    STATUS_SEVERITY,
    type StatusFilter,
    snoozedTooltip,
} from "../lib/labels";
import PriorityIcon from "./PriorityIcon.vue";
import { scopeIcon, scopeTitle, type Scope } from "../lib/scope";
import ListRow from "./ListRow.vue";
import TagBadge from "./TagBadge.vue";

// #B.132: who-spoke-last discrete cue. Read the current consumer
// once (it's set in localStorage by the header switcher and doesn't
// change reactively within a session — but we resolve at template-
// access time so a switch through the URL still works at next render).
const currentConsumer = () => localStorage.getItem("aiball.human_id") ?? "human";

const props = defineProps<{
    loading: boolean;
    rows: InboxRow[];
    project: string | null;
    selectedIds: Set<number>;
    searchActive: boolean;
    searchHits: SearchHit[];
    searchQuery: string;
    // #B.184: surface the active filter in the empty state so the
    // moderation-queue-by-default case ("compteurs ok mais rien dans
    // les listes") is self-explanatory instead of a dead end.
    statusFilter?: StatusFilter;
    onlyOpen?: boolean;
}>();

const emit = defineEmits<{
    (e: "open-row", row: InboxRow): void;
    (e: "open-hit", hit: SearchHit): void;
    (e: "toggle-read", row: InboxRow): void;
    (e: "toggle-selected", id: number, value: boolean): void;
    (e: "reset-filters"): void;
}>();

function filtersAreNarrowed(): boolean {
    return (props.statusFilter !== undefined && props.statusFilter !== "all")
        || props.onlyOpen === false;
}

// #B.255 bwsbc4: once at least one row is selected, the list is in
// "selection mode" — a normal tap toggles selection instead of
// opening the ticket. Drop to zero selected and tap reverts to its
// usual "open the row" behaviour. The mobile UX matches what users
// expect from Gmail / iOS Mail when a bulk batch is in flight.
function onRowClick(r: InboxRow) {
    if (props.selectedIds.size > 0) {
        emit("toggle-selected", r.id, !props.selectedIds.has(r.id));
        return;
    }
    emit("open-row", r);
}

</script>

<template>
    <div v-if="loading && !rows.length && !searchHits.length" class="aiball-empty">
        Loading…
    </div>
    <div v-else-if="searchActive && !searchHits.length" class="aiball-empty">
        <i class="pi pi-search" style="font-size: 1.6rem" />
        <div>No matches for « {{ searchQuery }} ».</div>
    </div>
    <div v-else-if="!searchActive && !rows.length" class="aiball-empty">
        <i class="pi pi-inbox" style="font-size: 1.6rem" />
        <div>
            No tickets match your filters{{ project ? ` in ${project}` : "" }}.
            <template v-if="statusFilter && statusFilter !== 'all'">
                Active status filter: <strong>{{ statusFilter }}</strong>.
            </template>
        </div>
        <Button
            v-if="filtersAreNarrowed()"
            label="Show all open tickets"
            icon="pi pi-filter-slash"
            text
            size="small"
            @click="emit('reset-filters')"
            style="margin-top: 0.6rem"
        />
    </div>

    <a
        v-for="hit in searchHits"
        :key="`${hit.kind}-${hit.id}`"
        :href="`/b/${hit.kind === 'comment' && hit.hashid ? hit.hashid : hit.ticket_id}`"
        class="search-hit"
        @click.prevent="emit('open-hit', hit)"
    >
        <div class="search-hit__head">
            <span class="ticket-id">
                {{ hit.kind === 'comment' ? `#C.${hit.hashid ?? hit.id}` : formatTicketRef(hit.ticket_id) }}
            </span>
            <Tag :value="hit.project" severity="info" style="font-size: 0.7rem" />
            <Tag
                v-if="hit.status !== 'approved'"
                :value="hit.status"
                :severity="STATUS_SEVERITY[hit.status]"
                style="font-size: 0.7rem"
            />
            <span v-if="hit.title" class="search-hit__title">{{ hit.title }}</span>
            <span class="spacer" />
            <span class="search-hit__by" v-if="hit.by_agent">by {{ hit.by_agent }}</span>
        </div>
        <div class="search-hit__snippet" v-html="hit.snippet" />
    </a>

    <ListRow
        v-if="!searchActive"
        v-for="r in rows"
        :key="r.id"
        :selected="selectedIds.has(r.id)"
        :unread="r.unread"
        :closed="r.closed"
        :attention="attentionOf(r)"
        @click="onRowClick(r)"
        @long-press="emit('toggle-selected', r.id, !selectedIds.has(r.id))"
    >
        <template #select>
            <Checkbox
                :model-value="selectedIds.has(r.id)"
                binary
                @update:model-value="(v: boolean) => emit('toggle-selected', r.id, v)"
            />
            <!-- #632 david `xsgcg6` : priority chevron juste après la case à
                 cocher (sans Tag/decoration badge). Couleur via severity, le
                 glyph porte toute l'info. Hidden quand normal (90% des tickets). -->
            <PriorityIcon
                v-if="r.priority && r.priority !== 'normal'"
                :priority="r.priority"
                :style="`color: var(${PRIORITY_COLOR_VAR[r.priority]}); margin-left: 0.25rem;`"
                :title="r.priority"
            />
        </template>
        <template #lead>
            <!--
                Read / unread toggle (per #C.tukrab on #B.58).
                Sits at the START of the row so it doubles as
                the read-state indicator (envelope closed when
                unread, envelope open when read). Clicking
                flips the state for this consumer.
            -->
            <button
                type="button"
                class="read-toggle-lead"
                :class="{ 'read-toggle-lead--unread': r.unread }"
                :title="r.unread ? 'Unread — click to mark read' : 'Read — click to mark unread'"
                :aria-pressed="r.unread"
                @click.stop="emit('toggle-read', r)"
            >
                <i class="pi pi-envelope" />
            </button>
            <!-- Lifecycle stage — single icon per row, deterministic.
                 The mapping lives in lib/labels.ts (LIFECYCLE_ICONS) so the
                 catalog stays auditable in one place; the only special case
                 is the snoozed tooltip which interpolates the wake-up date. -->
            <i
                :class="LIFECYCLE_ICONS[lifecycleStage(r)].icon"
                :title="lifecycleStage(r) === 'snoozed' ? snoozedTooltip(r.postponed_until) : LIFECYCLE_ICONS[lifecycleStage(r)].title"
                :style="`color: var(${LIFECYCLE_ICONS[lifecycleStage(r)].color})`"
            />
        </template>
        <!-- #542 david : `from` (reporter/owner) déplacé du title-line vers
             le chip-line après les tags. Le `#from` slot du ListRow n'est
             plus utilisé ici (le nom prenait de la place au start du titre
             pour 0 valeur quotidienne — c'est de l'info au repos, pas le
             principal). -->
        <template #title>
            <span
                v-if="r.hot"
                class="list-hot-focus"
                title="An agent has recent activity on this ticket (within the hot window). Claim status is shown separately by the bookmark icon."
                style="margin-right: 0.3rem"
            >🔥</span>
            <!-- #560 david : en multi-projet (`!project`), le nom du projet va
                 sur la title-line AVANT le #N, pas dans un badge. Texte plain
                 (pas un Tag PrimeVue), couleur muted pour rester discret. -->
            <span
                v-if="!project"
                class="list-row__project"
                :title="`Project: ${r.project}`"
            >{{ r.project }}</span>
            <span class="ticket-id">{{ formatTicketRef(r.id) }}</span>
            {{ titleOf(r) }}
            <!-- #B.245: per-event scope badge. Only render for
                 non-default scopes so the common case stays visually
                 quiet. `internal` → muted "private" eye-slash;
                 `broadcast` → loud megaphone. -->
            <i
                v-if="r.scope && r.scope !== 'default' && scopeIcon(r.scope as Scope)"
                :class="['pi', scopeIcon(r.scope as Scope)]"
                :style="{
                    marginLeft: '0.35rem',
                    color: r.scope === 'broadcast' ? 'var(--p-blue-500)' : 'var(--p-text-muted-color)',
                    fontSize: '0.85rem',
                }"
                :title="scopeTitle(r.scope as Scope)"
            />
        </template>
        <template v-if="snippetOf(r)" #snippet>{{ snippetOf(r) }}</template>
        <template
            v-if="r.status !== 'approved' || r.intent || (r.priority && r.priority !== 'normal') || r.tags.length || r.by_agent"
            #chips
        >
            <Tag
                v-if="r.status !== 'approved'"
                :value="r.status"
                :severity="STATUS_SEVERITY[r.status]"
                style="font-size: 0.7rem"
            />
            <Tag
                v-if="r.intent"
                :value="r.intent"
                :severity="r.intent ? INTENT_SEVERITY[r.intent] : 'secondary'"
                style="font-size: 0.7rem"
            />
            <!-- #B.222 + #632 david `xsgcg6` : la priority a quitté la chip row
                 pour rejoindre le slot `#select` (juste après la case à cocher),
                 sans decoration Tag. Le chevron coloré porte l'info à lui seul. -->
            <TagBadge
                v-for="tg in r.tags"
                :key="tg.id"
                :tag="tg"
                size="sm"
            />
            <!-- #560 david : le project passe sur la title-line (pas en chip).
                 Voir le `<span class="list-row__project">` au-dessus. -->
            <!-- #542 david : reporter (`by_agent`) en chip après les tags
                 plutôt qu'en tête de title-line — info au repos, libère le
                 title-line pour l'essentiel (id + titre + snippet). -->
            <span
                v-if="r.by_agent"
                class="list-row__by-agent"
                :title="`Reported by ${r.by_agent}`"
            >{{ r.by_agent }}</span>
        </template>
        <template #meta>
            <!-- #429: who currently holds this ticket — compact icon + tooltip
                 naming the holder (the tooltip carries the assignee/claimant,
                 per david). Claim (focus) and assignment (responsibility) are
                 distinct (#436); a row can show both. Role-specific glyph,
                 same as the thread header (bookmark-fill = self-claim,
                 user-plus = pushed assignment). -->
            <span
                v-if="r.claimant"
                class="list-row__hold"
                :title="`Claimed by ${r.claimant}${r.claimed_at ? ' · ' + new Date(r.claimed_at).toLocaleString() : ''}`"
            >
                <i class="pi pi-bookmark-fill" />
            </span>
            <span
                v-if="r.assignee"
                class="list-row__hold"
                :title="`Assigned to ${r.assignee}${r.assigned_at ? ' · ' + new Date(r.assigned_at).toLocaleString() : ''}`"
            >
                <i class="pi pi-user-plus" />
            </span>
            <!-- #427: per-ticket token-effort cost (cost-equiv; cache reads
                 weighted 0.1×). Shown only once any usage is captured, same
                 bolt glyph as the thread header. -->
            <span
                v-if="estTokenEffort(r.token_usage) > 0"
                class="list-row__token"
                :title="tokenBreakdownTitle(r.token_usage)"
            >
                <i class="pi pi-bolt" /> {{ formatTokens(estTokenEffort(r.token_usage)) }}
            </span>
            <span v-if="r.pending_comment_count > 0" :title="`${r.pending_comment_count} pending comment${r.pending_comment_count > 1 ? 's' : ''}`">
                <i class="pi pi-clock" /> {{ r.pending_comment_count }}
            </span>
            <span
                v-else-if="r.comment_count > 0 || r.last_speaker"
                :class="{ 'list-row__last-mine': r.last_speaker === currentConsumer() }"
                :title="r.last_speaker
                    ? (r.last_speaker === currentConsumer()
                        ? `You spoke last (${r.comment_count} comment${r.comment_count === 1 ? '' : 's'}).`
                        : `Last spoke: ${r.last_speaker} (${r.comment_count} comment${r.comment_count === 1 ? '' : 's'}).`)
                    : ''"
            >
                <i class="pi pi-comments" /> {{ r.comment_count }}
            </span>
        </template>
        <template #time>{{ relativeTime(r.last_activity) }}</template>
    </ListRow>
</template>

<style>
.aiball-empty {
    text-align: center;
    color: var(--p-text-muted-color);
    padding: 3rem 1rem;
    border: 1px dashed var(--p-content-border-color);
    border-radius: 0.5rem;
}
/* #B.132: tint the comments-count chip green when YOU were the last
   to speak. Discreet — same icon and number, just an accent color. */
.list-row__last-mine {
    color: var(--p-green-500);
}
/* #427: token-effort cost chip — amber bolt so it reads as "cost/energy"
   and doesn't blend into the muted comment count next to it. */
.list-row__token {
    color: var(--p-amber-500);
}
/* #429: claim/assign hold marker — discreet muted icon (the holder's name
   lives in the tooltip, not inline, to keep the list row compact). Matches
   the thread header's "afficher qui a claim mais pas dans un badge" intent. */
.list-row__hold {
    display: inline-flex;
    align-items: center;
    color: var(--p-text-muted-color);
}
.list-row__hold .pi {
    font-size: 0.78rem;
    opacity: 0.75;
}
.ticket-id {
    color: var(--p-text-muted-color);
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.85em;
    margin-right: 0.4rem;
}
/* #560 david : nom du projet en préfixe title-line (multi-projet only).
   Texte muted + monospace pour s'aligner visuellement avec le `#N` qui
   suit, mais pas un badge — david : « pas dasn un badge ». David `atsmzc` :
   pas de séparateur `/`, collé au `#N` qui suit ; la distinction visuelle
   passe par la couleur (project = muted, #N = primary, cf. ci-dessous). */
.list-row__project {
    color: var(--p-text-muted-color);
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.85em;
    margin-right: 0.15rem;
}
/* #560 david `atsmzc` : couleur primary sur le `#N` quand il vit dans la
   title-line, pour ressortir face au project name muted juste avant. On
   override uniquement dans ce contexte (pas le global `.ticket-id` qui sert
   aussi à la search-hit head + ailleurs). */
.list-row__line--title .ticket-id {
    color: var(--p-primary-color);
}
.read-toggle-lead {
    appearance: none;
    background: transparent;
    border: none;
    padding: 0.1rem;
    margin-right: 0.1rem;
    cursor: pointer;
    /* Read state by default → grey. Click toggles via toggleRead(). */
    color: var(--p-text-muted-color);
    transition: color 0.12s, transform 0.08s;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.read-toggle-lead:hover {
    transform: scale(1.1);
}
.read-toggle-lead--unread {
    /* Unread → green so the eye lands on the row from a distance. */
    color: var(--p-green-500);
}
.search-hit {
    display: block;
    text-decoration: none;
    color: inherit;
    padding: 0.5rem 0.7rem;
    border-bottom: 1px solid var(--p-content-border-color);
    cursor: pointer;
    transition: background 0.1s;
}
.search-hit:hover {
    background: var(--p-surface-100);
}
.search-hit__head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.3rem;
    font-size: 0.9rem;
}
.search-hit__title {
    font-weight: 600;
    color: var(--p-text-color);
}
.search-hit__by {
    font-size: 0.8rem;
    color: var(--p-text-muted-color);
}
.search-hit__snippet {
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
    line-height: 1.4;
    white-space: pre-wrap;
    word-wrap: break-word;
}
.search-hit__snippet mark {
    background: color-mix(in srgb, var(--p-yellow-500) 30%, transparent);
    color: var(--p-text-color);
    padding: 0 0.1rem;
    border-radius: 2px;
}
/* #542 — reporter chip dans la chip-line (post-tags). Discret, italic muted,
   pas de fond — c'est de l'info au repos, pas un Tag importable. */
.list-row__by-agent {
    font-size: 0.72rem;
    color: var(--p-text-muted-color);
    font-style: italic;
    margin-left: 0.2rem;
}
</style>
