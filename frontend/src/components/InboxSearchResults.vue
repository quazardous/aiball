<script setup lang="ts">
/**
 * InboxSearchResults — the grouped search-results block (UI-audit C5.1,
 * extracted from InboxList : computed + interface + CSS were fully
 * self-contained). One group per ticket : head = the ticket hit (or a
 * synthetic head from the first comment hit), comment hits indented.
 */
import { computed } from "vue";
import Tag from "primevue/tag";
import { type SearchHit } from "../lib/api";
import { formatTicketRef } from "../lib/formatting";
import { ticketHref } from "../lib/base";
import { STATUS_SEVERITY } from "../lib/labels";

const props = defineProps<{
    searchHits: SearchHit[];
}>();
const emit = defineEmits<{
    (e: "open-hit", hit: SearchHit): void;
}>();

// #842 david `qfhu33` : la recherche regroupe par ticket. Plusieurs comment
// hits du même ticket = une seule ligne head + sous-lignes per comment.
// Le head est le ticket hit si présent (= match dans le body/titre du
// ticket), sinon synthétisé à partir du premier comment hit.
interface SearchGroup {
    ticket_id: number;
    title: string | null;
    project: string;
    status: string;
    by_agent: string | null;
    ticketHit: SearchHit | null;
    commentHits: SearchHit[];
}
const groupedSearchHits = computed<SearchGroup[]>(() => {
    const groups = new Map<number, SearchGroup>();
    for (const h of props.searchHits) {
        let g = groups.get(h.ticket_id);
        if (!g) {
            g = {
                ticket_id: h.ticket_id,
                title: h.title,
                project: h.project,
                status: h.status,
                by_agent: h.by_agent,
                ticketHit: null,
                commentHits: [],
            };
            groups.set(h.ticket_id, g);
        }
        if (h.kind === "ticket") {
            g.ticketHit = h;
            // Le ticket hit porte le titre canonique
            g.title = h.title ?? g.title;
            g.status = h.status;
            g.by_agent = h.by_agent ?? g.by_agent;
        } else {
            g.commentHits.push(h);
        }
    }
    return [...groups.values()];
});
</script>

<template>
    <!-- #842 Phase 2 : grouping par ticket. Head = le ticket hit (si match
         body/titre du ticket) OU la première sous-ligne synthétique ; les
         comment hits du ticket sont sous-lignes indentées. -->
    <div
        v-for="group in groupedSearchHits"
        :key="group.ticket_id"
        class="search-group"
    >
        <a
            v-if="group.ticketHit"
            :href="ticketHref(group.ticket_id)"
            class="search-hit"
            @click.prevent="emit('open-hit', group.ticketHit)"
        >
            <div class="search-hit__head">
                <span class="ticket-id">{{ formatTicketRef(group.ticket_id) }}</span>
                <Tag :value="group.project" severity="info" style="font-size: 0.7rem" />
                <Tag
                    v-if="group.status !== 'approved'"
                    :value="group.status"
                    :severity="STATUS_SEVERITY[group.status as keyof typeof STATUS_SEVERITY]"
                    style="font-size: 0.7rem"
                />
                <span v-if="group.title" class="search-hit__title">{{ group.title }}</span>
                <span class="spacer" />
                <span class="search-hit__by" v-if="group.by_agent">by {{ group.by_agent }}</span>
            </div>
            <div class="search-hit__snippet" v-html="group.ticketHit.snippet" />
        </a>
        <div v-else class="search-group__head-only">
            <span class="ticket-id">{{ formatTicketRef(group.ticket_id) }}</span>
            <Tag :value="group.project" severity="info" style="font-size: 0.7rem" />
            <span v-if="group.title" class="search-hit__title">{{ group.title }}</span>
        </div>
        <a
            v-for="hit in group.commentHits"
            :key="`comment-${hit.id}`"
            :href="ticketHref(hit.hashid ?? hit.id)"
            class="search-hit search-hit--comment"
            @click.prevent="emit('open-hit', hit)"
        >
            <div class="search-hit__sub">
                <span class="ticket-id">↪ #C.{{ hit.hashid ?? hit.id }}</span>
                <span class="spacer" />
                <span class="search-hit__by" v-if="hit.by_agent">by {{ hit.by_agent }}</span>
            </div>
            <div class="search-hit__snippet" v-html="hit.snippet" />
        </a>
    </div>
</template>

<style>
/* Non-scoped like the parent (dark-theme reach) ; the .search-* namespace
   moved here with the markup it styles. `.ticket-id` styling stays in
   InboxList (shared with the row titles). */
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
    font-size: var(--fs-lg);
}
.search-hit__title {
    font-weight: 600;
    color: var(--p-text-color);
}
.search-hit__by {
    font-size: var(--fs-sm);
    color: var(--p-text-muted-color);
}
.search-hit__snippet {
    font-size: var(--fs-md);
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
/* #842 Phase 2 — grouping ticket-oriented. */
.search-group {
    border-bottom: 1px solid var(--p-content-border-color);
}
.search-group__head-only {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.7rem 0.3rem;
    font-size: var(--fs-lg);
}
.search-group .search-hit {
    border-bottom: none;
}
.search-hit--comment {
    padding-left: 1.8rem;
    background: color-mix(in srgb, var(--p-surface-100) 40%, transparent);
}
.search-hit--comment .search-hit__snippet {
    padding-left: 0.2rem;
}
.search-hit__sub {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--fs-sm);
    color: var(--p-text-muted-color);
    margin-bottom: 0.25rem;
}
</style>
