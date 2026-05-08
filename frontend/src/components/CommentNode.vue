<script setup lang="ts">
import { ref } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import MarkdownView from "./MarkdownView.vue";
import { api, type Message } from "../lib/api";

const props = defineProps<{ msg: Message }>();
const emit = defineEmits<{ (e: "submitted"): void }>();

const decideBusy = ref(false);
async function decide(action: "approve" | "reject") {
    decideBusy.value = true;
    try {
        if (action === "approve") await api.approve(props.msg.id);
        else await api.reject(props.msg.id);
        emit("submitted");
    } finally {
        decideBusy.value = false;
    }
}

const justCopied = ref(false);
async function copyRef() {
    const ref_ = `#${props.msg.id}`;
    try {
        await navigator.clipboard.writeText(ref_);
        justCopied.value = true;
        setTimeout(() => (justCopied.value = false), 1500);
    } catch {
        /* clipboard write rejected (focus / permissions) — silent */
    }
}
</script>

<template>
    <div
        class="comment-card"
        :class="{ 'comment-card--pending': msg.status === 'pending' }"
        :id="`comment-${msg.id}`"
    >
        <header class="meta">
            <Tag :value="`#${msg.id}`" severity="secondary" />
            <Tag
                v-if="msg.status === 'pending'"
                value="pending"
                severity="warn"
            />
            <span v-if="msg.by_agent">by {{ msg.by_agent }}</span>
            <span class="spacer" />
            <span :title="msg.created_at">
                {{ new Date(msg.created_at).toLocaleString() }}
            </span>
        </header>
        <MarkdownView :source="msg.edited_body ?? msg.body" />
        <div v-if="msg.human_note" class="comment-note">
            <i class="pi pi-comment" />
            <em>{{ msg.human_note }}</em>
        </div>
        <div class="comment-actions">
            <Button
                :icon="justCopied ? 'pi pi-check' : 'pi pi-hashtag'"
                :label="justCopied ? `copied #${msg.id}` : 'copy ref'"
                size="small"
                severity="secondary"
                text
                title="Copy this comment's reference (e.g. #42) to clipboard so you can paste it in your reply"
                @click="copyRef"
            />
            <template v-if="msg.status === 'pending'">
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
    </div>
</template>
