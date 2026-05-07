<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { api, type Message, type ThreadView as ThreadViewData } from "../lib/api";
import MarkdownView from "./MarkdownView.vue";
import ReplyBox from "./ReplyBox.vue";
import CommentNode, { type NestedComment } from "./CommentNode.vue";

const props = defineProps<{ ticketId: number }>();
const emit = defineEmits<{ (e: "back"): void }>();

const data = ref<ThreadViewData | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const replyTo = ref<number | null>(null);

async function load() {
    loading.value = true;
    error.value = null;
    try {
        data.value = await api.getTicket(props.ticketId);
        replyTo.value = null;
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        loading.value = false;
    }
}

watch(() => props.ticketId, load);
onMounted(load);
defineExpose({ load });

function buildTree(comments: Message[], rootId: number): NestedComment[] {
    const byParent = new Map<number, Message[]>();
    for (const c of comments) {
        const p = c.parent_id ?? rootId;
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p)!.push(c);
    }
    const sortChrono = (a: Message, b: Message) => a.id - b.id;
    function build(id: number): NestedComment[] {
        const children = (byParent.get(id) ?? []).slice().sort(sortChrono);
        return children.map((m) => ({ msg: m, children: build(m.id) }));
    }
    return build(rootId);
}

const tree = computed<NestedComment[]>(() => {
    if (!data.value) return [];
    return buildTree(data.value.comments, data.value.ticket.id);
});
</script>

<template>
    <div class="thread-view">
        <div class="thread-toolbar">
            <Button
                icon="pi pi-arrow-left"
                label="back"
                severity="secondary"
                text
                size="small"
                @click="emit('back')"
            />
            <span class="spacer" />
            <Button
                icon="pi pi-refresh"
                severity="secondary"
                text
                rounded
                :loading="loading"
                @click="load"
            />
        </div>

        <div v-if="error" class="aiball-empty" style="color: var(--p-red-500)">
            {{ error }}
        </div>
        <div v-else-if="!data && loading" class="aiball-empty">Loading…</div>
        <template v-else-if="data">
            <article class="thread-ticket">
                <header class="meta">
                    <Tag :value="`#${data.ticket.id}`" severity="secondary" />
                    <Tag :value="data.ticket.project" severity="info" />
                    <Tag
                        v-if="data.ticket.closed"
                        value="closed"
                        severity="danger"
                    />
                    <span v-if="data.ticket.by_agent">by {{ data.ticket.by_agent }}</span>
                    <span class="spacer" />
                    <span :title="data.ticket.created_at">
                        {{ new Date(data.ticket.created_at).toLocaleString() }}
                    </span>
                </header>
                <h2 class="thread-title">{{ data.ticket.title }}</h2>
                <MarkdownView :source="data.ticket.body" />
            </article>

            <div v-if="tree.length === 0" class="aiball-empty thread-no-comments">
                No comments yet — be the first to reply.
            </div>

            <ul v-else class="thread-comments">
                <li
                    v-for="node in tree"
                    :key="node.msg.id"
                    class="thread-comment"
                >
                    <CommentNode
                        :node="node"
                        :reply-to="replyTo"
                        @reply="(id: number) => (replyTo = id)"
                        @cancel-reply="replyTo = null"
                        @submitted="load"
                    />
                </li>
            </ul>

            <ReplyBox
                v-if="!data.ticket.closed && replyTo === null"
                :project="data.ticket.project"
                :ticket-id="data.ticket.id"
                :parent-id="data.ticket.id"
                placeholder="Reply on this thread (markdown supported)"
                @submitted="load"
            />
        </template>
    </div>
</template>

<style>
.thread-view {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
}
.thread-toolbar {
    display: flex;
    align-items: center;
}
.thread-ticket {
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.5rem;
    padding: 0.9rem 1rem;
    background: var(--p-content-background);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}
.thread-title {
    margin: 0;
    font-size: 1.3rem;
    font-weight: 600;
}
.thread-no-comments { padding: 1rem; }
.thread-comments {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
}
.thread-comments.nested {
    margin-left: 1.4rem;
    margin-top: 0.6rem;
    border-left: 2px solid var(--p-content-border-color);
    padding-left: 0.8rem;
}
.comment-card {
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.4rem;
    padding: 0.7rem 0.9rem;
    background: var(--p-content-background);
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}
.comment-card .meta {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
}
.comment-note {
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
}
.comment-actions {
    display: flex;
    gap: 0.4rem;
}
.comment-reply {
    margin-top: 0.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}
</style>
