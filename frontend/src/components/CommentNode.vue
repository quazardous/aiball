<script setup lang="ts">
import { ref } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import MarkdownView from "./MarkdownView.vue";
import MessageComposer from "./MessageComposer.vue";
import { api, type Message } from "../lib/api";

export interface NestedComment {
    msg: Message;
    children: NestedComment[];
}

const props = defineProps<{
    node: NestedComment;
    replyTo: number | null;
}>();

const emit = defineEmits<{
    (e: "reply", id: number): void;
    (e: "cancelReply"): void;
    (e: "submitted"): void;
}>();

const decideBusy = ref(false);
async function decide(action: "approve" | "reject") {
    decideBusy.value = true;
    try {
        if (action === "approve") await api.approve(props.node.msg.id);
        else await api.reject(props.node.msg.id);
        emit("submitted");
    } finally {
        decideBusy.value = false;
    }
}
</script>

<template>
    <div
        class="comment-card"
        :class="{ 'comment-card--pending': node.msg.status === 'pending' }"
        :id="`comment-${node.msg.id}`"
    >
        <header class="meta">
            <Tag :value="`#${node.msg.id}`" severity="secondary" />
            <Tag
                v-if="node.msg.status === 'pending'"
                value="pending"
                severity="warn"
            />
            <span v-if="node.msg.by_agent">by {{ node.msg.by_agent }}</span>
            <span class="spacer" />
            <span :title="node.msg.created_at">
                {{ new Date(node.msg.created_at).toLocaleString() }}
            </span>
        </header>
        <MarkdownView :source="node.msg.edited_body ?? node.msg.body" />
        <div v-if="node.msg.human_note" class="comment-note">
            <i class="pi pi-comment" />
            <em>{{ node.msg.human_note }}</em>
        </div>
        <div class="comment-actions">
            <Button
                v-if="node.msg.status === 'approved'"
                icon="pi pi-reply"
                label="reply"
                size="small"
                severity="secondary"
                text
                @click="emit('reply', node.msg.id)"
            />
            <template v-if="node.msg.status === 'pending'">
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
            </template>
        </div>
        <div v-if="replyTo === node.msg.id" class="comment-reply">
            <MessageComposer
                mode="comment"
                :project="node.msg.project"
                :ticket-id="node.msg.ticket_id ?? node.msg.id"
                :parent-id="node.msg.id"
                :placeholder="`Reply to #${node.msg.id} (markdown supported)`"
                @submitted="emit('submitted')"
            />
            <Button
                icon="pi pi-times"
                label="cancel"
                size="small"
                severity="secondary"
                text
                @click="emit('cancelReply')"
            />
        </div>
        <ul v-if="node.children.length" class="thread-comments nested">
            <li
                v-for="child in node.children"
                :key="child.msg.id"
                class="thread-comment"
            >
                <CommentNode
                    :node="child"
                    :reply-to="replyTo"
                    @reply="(id: number) => emit('reply', id)"
                    @cancel-reply="emit('cancelReply')"
                    @submitted="emit('submitted')"
                />
            </li>
        </ul>
    </div>
</template>
