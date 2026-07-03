<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api, type TokenUsage } from "../lib/api";
import { formatTicketRef } from "../lib/formatting";
import { ticketHref } from "../lib/base";
import { estTokenCost, estTokenEffort, formatTokens } from "../lib/format";
import { useLoader } from "../lib/loader";
import AdminDashboardLayout from "./ui/AdminDashboardLayout.vue";
import AsyncState from "./ui/AsyncState.vue";
import SectionHeader from "./ui/SectionHeader.vue";

const props = defineProps<{
    project: string;
    /** #471 — embed mode (no own breadcrumb). */
    embedded?: boolean;
}>();

const emit = defineEmits<{
    (e: "back"): void;
}>();

interface OldestOpen {
    id: number;
    title: string;
    by_agent: string | null;
    created_at: string;
    age_days: number;
}

interface ProjectStatsRich {
    project: string;
    ticket_count: number;
    comment_count: number;
    open_count: number;
    closed_count: number;
    resolved_count: number;
    pending_mod: number;
    pending_resolution: number;
    resolved_pct: number;
    oldest_open: OldestOpen | null;
    avg_age_open_days: number;
    top_reporters: { agent: string; count: number }[];
    top_tags: { name: string; count: number }[];
    top_intents: { intent: string; count: number }[];
    auto_approved_pct: number;
    token_usage: TokenUsage | null;
    top_token_tickets: { id: number; title: string; token_usage: TokenUsage }[];
}

const stats = ref<ProjectStatsRich | null>(null);

const { loading, error, load } = useLoader(async () => {
    stats.value = await api.projectStatsRich(props.project) as ProjectStatsRich;
}, { mountLoad: true });

watch(() => props.project, () => load());

const topReporterMax = computed(() =>
    stats.value && stats.value.top_reporters.length > 0
        ? stats.value.top_reporters[0].count
        : 1,
);
const topTagMax = computed(() =>
    stats.value && stats.value.top_tags.length > 0
        ? stats.value.top_tags[0].count
        : 1,
);
const topIntentMax = computed(() =>
    stats.value && stats.value.top_intents.length > 0
        ? stats.value.top_intents[0].count
        : 1,
);
// #406/#446 — scale the bars off the EFFORT headline (in+out+cache-write),
// consistent with the rest of the UI. The server pre-sorts by cost, which may
// not match effort order, so take the max effort over the list (not [0]) to
// keep every bar ≤ 100%.
const topTokenMax = computed(() =>
    stats.value && stats.value.top_token_tickets.length > 0
        ? Math.max(...stats.value.top_token_tickets.map((t) => estTokenEffort(t.token_usage)), 1)
        : 1,
);
</script>

<template>
    <AdminDashboardLayout
        class="project-stats"
        :crumbs="[{ label: 'Inbox', href: '/' }]"
        :current="project"
        title="Stats"
        :embedded="embedded"
        @close-to-inbox="emit('back')"
    >
        <template #actions>
            <button
                type="button"
                class="project-stats__refresh"
                title="Refresh stats"
                @click="load"
            >
                <i class="pi pi-refresh" />
            </button>
        </template>

        <AsyncState :loading="loading" :error="error">
            <template v-if="stats">
                <!-- Pulse: 4 big numbers at a glance -->
                <section class="project-stats__pulse">
                    <div class="stat-card">
                        <div class="stat-card__value">{{ stats.ticket_count }}</div>
                        <div class="stat-card__label">tickets</div>
                        <div class="stat-card__sub">{{ stats.comment_count }} comments</div>
                    </div>
                    <div class="stat-card stat-card--accent">
                        <div class="stat-card__value">{{ stats.open_count }}</div>
                        <div class="stat-card__label">open</div>
                        <div class="stat-card__sub">{{ stats.closed_count }} closed</div>
                    </div>
                    <div class="stat-card stat-card--success">
                        <div class="stat-card__value">{{ stats.resolved_pct }}%</div>
                        <div class="stat-card__label">resolved</div>
                        <div class="stat-card__sub">{{ stats.resolved_count }} / {{ stats.closed_count }}</div>
                    </div>
                    <div class="stat-card stat-card--muted">
                        <div class="stat-card__value">{{ stats.auto_approved_pct }}%</div>
                        <div class="stat-card__label">auto-approved</div>
                        <div class="stat-card__sub">moderation pressure</div>
                    </div>
                </section>

                <!-- Live: oldest, average age, pending counts -->
                <section class="project-stats__section">
                    <SectionHeader title="Live tickets" />
                    <dl class="project-stats__live">
                        <div v-if="stats.oldest_open">
                            <dt>Oldest open</dt>
                            <dd>
                                <a :href="ticketHref(stats.oldest_open.id)" class="project-stats__ref">
                                    {{ formatTicketRef(stats.oldest_open.id) }}
                                </a>
                                <span class="project-stats__title">{{ stats.oldest_open.title }}</span>
                                <span class="project-stats__meta">
                                    · {{ stats.oldest_open.age_days }}d
                                    <template v-if="stats.oldest_open.by_agent"> · by {{ stats.oldest_open.by_agent }}</template>
                                </span>
                            </dd>
                        </div>
                        <div>
                            <dt>Avg age of open</dt>
                            <dd>{{ stats.avg_age_open_days }}d</dd>
                        </div>
                        <div>
                            <dt>Pending moderation</dt>
                            <dd :class="{ 'project-stats__warn': stats.pending_mod > 0 }">
                                {{ stats.pending_mod }}
                            </dd>
                        </div>
                        <div>
                            <dt>Pending resolution</dt>
                            <dd :class="{ 'project-stats__warn': stats.pending_resolution > 0 }">
                                {{ stats.pending_resolution }}
                            </dd>
                        </div>
                    </dl>
                </section>

                <!-- Top N: reporters, tags, intents — three columns -->
                <section class="project-stats__section project-stats__topn">
                    <div>
                        <SectionHeader title="Top reporters" />
                        <ol class="project-stats__bars">
                            <li v-for="r in stats.top_reporters" :key="r.agent">
                                <span class="project-stats__bar-name">{{ r.agent }}</span>
                                <span class="project-stats__bar-track">
                                    <span
                                        class="project-stats__bar-fill"
                                        :style="`width: ${(r.count / topReporterMax * 100).toFixed(1)}%`"
                                    />
                                </span>
                                <span class="project-stats__bar-count">{{ r.count }}</span>
                            </li>
                            <li v-if="stats.top_reporters.length === 0" class="project-stats__empty">
                                none
                            </li>
                        </ol>
                    </div>
                    <div>
                        <SectionHeader title="Top tags" />
                        <ol class="project-stats__bars">
                            <li v-for="t in stats.top_tags" :key="t.name">
                                <span class="project-stats__bar-name">{{ t.name }}</span>
                                <span class="project-stats__bar-track">
                                    <span
                                        class="project-stats__bar-fill"
                                        :style="`width: ${(t.count / topTagMax * 100).toFixed(1)}%`"
                                    />
                                </span>
                                <span class="project-stats__bar-count">{{ t.count }}</span>
                            </li>
                            <li v-if="stats.top_tags.length === 0" class="project-stats__empty">
                                none
                            </li>
                        </ol>
                    </div>
                    <div>
                        <SectionHeader title="Intents" />
                        <ol class="project-stats__bars">
                            <li v-for="i in stats.top_intents" :key="i.intent">
                                <span class="project-stats__bar-name">{{ i.intent }}</span>
                                <span class="project-stats__bar-track">
                                    <span
                                        class="project-stats__bar-fill"
                                        :style="`width: ${(i.count / topIntentMax * 100).toFixed(1)}%`"
                                    />
                                </span>
                                <span class="project-stats__bar-count">{{ i.count }}</span>
                            </li>
                            <li v-if="stats.top_intents.length === 0" class="project-stats__empty">
                                none
                            </li>
                        </ol>
                    </div>
                </section>

                <!-- Token effort (#406): cost-equivalent aggregate + costliest tickets.
                     Hidden until any usage is captured (#404). -->
                <section v-if="stats.token_usage" class="project-stats__section">
                    <SectionHeader title="Token effort" />
                    <div class="project-stats__token-summary">
                        <div class="stat-card stat-card--accent">
                            <div class="stat-card__value">⚡ {{ formatTokens(estTokenEffort(stats.token_usage)) }}</div>
                            <div class="stat-card__label">effort (new tokens)</div>
                            <div class="stat-card__sub">cost-equiv ~{{ formatTokens(estTokenCost(stats.token_usage)) }} · re-read context ×0.1</div>
                        </div>
                        <dl class="project-stats__token-raw">
                            <div><dt>input</dt><dd>{{ formatTokens(stats.token_usage.tokens_in) }}</dd></div>
                            <div><dt>output</dt><dd>{{ formatTokens(stats.token_usage.tokens_out) }}</dd></div>
                            <div><dt>cache write</dt><dd>{{ formatTokens(stats.token_usage.cache_w) }}</dd></div>
                            <div><dt>cache read</dt><dd>{{ formatTokens(stats.token_usage.cache_r) }}</dd></div>
                        </dl>
                    </div>
                    <h4
                        v-if="stats.top_token_tickets.length > 0"
                        class="project-stats__token-top-label"
                    >
                        Top 3 token-heavy tickets
                    </h4>
                    <ol
                        v-if="stats.top_token_tickets.length > 0"
                        class="project-stats__bars project-stats__token-top"
                    >
                        <li v-for="t in stats.top_token_tickets" :key="t.id">
                            <a :href="ticketHref(t.id)" class="project-stats__bar-name" :title="t.title">
                                <span class="project-stats__ref">{{ formatTicketRef(t.id) }}</span>
                                {{ t.title }}
                            </a>
                            <span class="project-stats__bar-track">
                                <span
                                    class="project-stats__bar-fill"
                                    :style="`width: ${(estTokenEffort(t.token_usage) / topTokenMax * 100).toFixed(1)}%`"
                                />
                            </span>
                            <span class="project-stats__bar-count">{{ formatTokens(estTokenEffort(t.token_usage)) }}</span>
                        </li>
                    </ol>
                </section>
            </template>
        </AsyncState>
    </AdminDashboardLayout>
</template>

<style>
/* Layout (largeur + gouttière + breadcrumb) → `<AdminDashboardLayout>` (#458). */
.project-stats__refresh {
    background: transparent;
    border: 0;
    color: var(--p-text-muted-color);
    cursor: pointer;
    padding: 0.3rem 0.5rem;
    border-radius: 0.3rem;
}
.project-stats__refresh:hover {
    background: var(--p-surface-100);
}
.project-stats__pulse {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.6rem;
}
@media (max-width: 720px) {
    .project-stats__pulse { grid-template-columns: repeat(2, 1fr); }
}
.stat-card {
    padding: 0.8rem 1rem;
    background: var(--p-surface-50);
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
}
.stat-card--accent {
    border-left: 3px solid var(--p-primary-color);
}
.stat-card--success {
    border-left: 3px solid var(--p-green-500);
}
.stat-card--muted {
    border-left: 3px solid var(--p-surface-400);
}
.stat-card__value {
    font-size: 1.8rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--p-text-color);
}
.stat-card__label {
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--p-text-muted-color);
}
.stat-card__sub {
    font-size: 0.78rem;
    color: var(--p-text-muted-color);
}
.project-stats__section {
    padding: 0.8rem 1rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.5rem;
    background: var(--p-content-background);
}
.project-stats__section h3 {
    margin: 0 0 0.5rem;
    font-size: 0.9rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--p-text-muted-color);
    font-weight: 600;
}
.project-stats__live {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.5rem 1.2rem;
    margin: 0;
}
.project-stats__live > div {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
}
.project-stats__live dt {
    font-size: 0.78rem;
    color: var(--p-text-muted-color);
}
.project-stats__live dd {
    margin: 0;
    font-size: 0.95rem;
    color: var(--p-text-color);
    font-variant-numeric: tabular-nums;
}
.project-stats__ref {
    font-family: ui-monospace, SFMono-Regular, monospace;
    color: var(--p-primary-color);
    text-decoration: none;
    font-weight: 600;
}
.project-stats__ref:hover {
    text-decoration: underline;
}
.project-stats__title {
    margin-left: 0.4rem;
    overflow: hidden;
    text-overflow: ellipsis;
}
.project-stats__meta {
    color: var(--p-text-muted-color);
    font-size: 0.85em;
}
.project-stats__warn {
    color: var(--p-yellow-700);
    font-weight: 600;
}
.project-stats__topn {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
}
@media (max-width: 720px) {
    .project-stats__topn { grid-template-columns: 1fr; }
}
.project-stats__bars {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
}
.project-stats__bars li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 5rem 2.5rem;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
}
.project-stats__bar-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--p-text-color);
}
.project-stats__bar-track {
    height: 0.5rem;
    background: var(--p-surface-200);
    border-radius: 0.25rem;
    overflow: hidden;
}
.project-stats__bar-fill {
    display: block;
    height: 100%;
    background: var(--p-primary-color);
}
.project-stats__bar-count {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--p-text-muted-color);
}
.project-stats__empty {
    color: var(--p-text-muted-color);
    font-style: italic;
    display: block !important;
    grid-template-columns: none !important;
}
/* #406 — token effort section */
.project-stats__token-summary {
    display: flex;
    gap: 1rem;
    align-items: stretch;
    flex-wrap: wrap;
    margin-bottom: 0.8rem;
}
.project-stats__token-summary .stat-card {
    min-width: 9rem;
}
.project-stats__token-raw {
    display: grid;
    grid-template-columns: repeat(2, auto);
    gap: 0.3rem 1.4rem;
    margin: 0;
    align-content: center;
}
.project-stats__token-raw > div {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
}
.project-stats__token-raw dt {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--p-text-muted-color);
}
.project-stats__token-raw dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
    color: var(--p-text-color);
}
.project-stats__token-top-label {
    margin: 0.2rem 0 0.35rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--p-text-muted-color);
    font-weight: 600;
}
.project-stats__token-top li {
    grid-template-columns: minmax(0, 1fr) 5rem 4rem;
}
.project-stats__token-top .project-stats__bar-name {
    text-decoration: none;
    color: var(--p-text-color);
}
.project-stats__token-top .project-stats__bar-name:hover {
    text-decoration: underline;
}
</style>
