<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { api, type Message, type ThreadView as ThreadViewData } from "../lib/api";
import MarkdownView from "./MarkdownView.vue";
import MessageComposer from "./MessageComposer.vue";
import CommentNode, { type NestedComment } from "./CommentNode.vue";

const props = defineProps<{ ticketId: number }>();
const emit = defineEmits<{ (e: "back"): void }>();

const data = ref<ThreadViewData | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const replyTo = ref<number | null>(null);
const decideBusy = ref(false);

async function load() {
    loading.value = true;
    error.value = null;
    try {
        data.value = await api.getTicket(props.ticketId);
        replyTo.value = null;
        // If the API resolved a non-ticket id up to its parent thread, scroll
        // to the requested message after Vue has painted the comments.
        const focus = data.value?.focus_message_id ?? null;
        if (focus !== null) {
            requestAnimationFrame(() => {
                const el = document.getElementById(`comment-${focus}`);
                if (el) {
                    el.scrollIntoView({ behavior: "smooth", block: "center" });
                    el.classList.add("comment-card--focused");
                    setTimeout(() => el.classList.remove("comment-card--focused"), 2500);
                }
            });
        }
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        loading.value = false;
    }
}

watch(() => props.ticketId, load);
onMounted(load);
defineExpose({ load });

function statusSeverity(s: "pending" | "approved" | "rejected") {
    if (s === "pending") return "warn";
    if (s === "approved") return "success";
    return "danger";
}

async function decide(action: "approve" | "reject") {
    if (!data.value) return;
    decideBusy.value = true;
    try {
        if (action === "approve") await api.approve(data.value.ticket.id);
        else await api.reject(data.value.ticket.id);
        await load();
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        decideBusy.value = false;
    }
}

const closeBusy = ref(false);
async function postLifecycle(kind: "ticket_closed" | "ticket_reopened") {
    if (!data.value) return;
    const t = data.value.ticket;
    closeBusy.value = true;
    try {
        const byAgent = localStorage.getItem("aiball.human_id") || "human";
        const res = await fetch("/api/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                project: t.project,
                kind,
                ticket_id: t.id,
                parent_id: t.id,
                by_agent: byAgent,
            }),
        });
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        await load();
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        closeBusy.value = false;
    }
}
function closeTicket() { return postLifecycle("ticket_closed"); }
function reopenTicket() { return postLifecycle("ticket_reopened"); }

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
                v-if="data && data.ticket.status === 'approved' && !data.ticket.closed"
                icon="pi pi-lock"
                label="close ticket"
                severity="secondary"
                size="small"
                :loading="closeBusy"
                @click="closeTicket"
            />
            <Button
                v-else-if="data && data.ticket.status === 'approved' && data.ticket.closed"
                icon="pi pi-unlock"
                label="reopen"
                severity="secondary"
                size="small"
                :loading="closeBusy"
                @click="reopenTicket"
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
                        :value="data.ticket.status"
                        :severity="statusSeverity(data.ticket.status)"
                    />
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
                <div v-if="data.ticket.status === 'pending'" class="thread-decide">
                    <Button
                        label="approve"
                        icon="pi pi-check"
                        severity="success"
                        size="small"
                        :loading="decideBusy"
                        @click="decide('approve')"
                    />
                    <Button
                        label="reject"
                        icon="pi pi-times"
                        severity="danger"
                        size="small"
                        :loading="decideBusy"
                        @click="decide('reject')"
                    />
                </div>
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

            <MessageComposer
                v-if="!data.ticket.closed && data.ticket.status !== 'rejected' && replyTo === null"
                mode="comment"
                :project="data.ticket.project"
                :ticket-id="data.ticket.id"
                :parent-id="data.ticket.id"
                :placeholder="data.ticket.status === 'pending'
                    ? 'Reply on this pending thread (markdown supported) — your comment goes through moderation unless you are human'
                    : 'Reply on this thread (markdown supported)'"
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
.thread-decide {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    margin-top: 0.4rem;
}
.comment-card--focused {
    box-shadow: 0 0 0 2px var(--p-primary-color);
    transition: box-shadow 0.2s;
}
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
