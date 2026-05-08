<script setup lang="ts">
import { computed, ref } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import MarkdownView from "./MarkdownView.vue";
import { api, type Message } from "../lib/api";

const props = defineProps<{
    msg: Message;
    /**
     * The latest pending comment in the thread is the only one that shows
     * the "pending" tag — older pending entries are visible but unobtrusive
     * so the eye lands on the most recent moderation request.
     */
    showPendingTag?: boolean;
}>();
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
const commentRef = computed(() => {
    // Prefer the hashid if available (canonical since 0003 migration).
    // Fall back to the integer id for any legacy row that somehow lacks
    // a hashid — the backend's /b/:ref still resolves both forms.
    const h = props.msg.hashid;
    return h ? `#C${h}` : `#C${props.msg.id}`;
});
async function copyRef() {
    try {
        await navigator.clipboard.writeText(commentRef.value);
        justCopied.value = true;
        setTimeout(() => (justCopied.value = false), 1500);
    } catch {
        /* clipboard write rejected (focus / permissions) — silent */
    }
}

const LIFECYCLE_LABELS: Record<string, { icon: string; verb: string; severity: "success" | "warn" | "info" }> = {
    ticket_closed: { icon: "pi pi-lock", verb: "closed this ticket", severity: "warn" },
    ticket_reopened: { icon: "pi pi-unlock", verb: "reopened this ticket", severity: "info" },
    ticket_resolved: { icon: "pi pi-check-circle", verb: "marked this ticket resolved", severity: "success" },
};
</script>

<template>
    <div
        class="comment-card"
        :class="{ 'comment-card--pending': msg.status === 'pending' }"
        :id="`comment-${msg.id}`"
    >
        <header class="meta">
            <Tag
                v-if="msg.status === 'pending' && showPendingTag"
                value="pending"
                severity="warn"
            />
            <span
                v-else-if="msg.status === 'pending'"
                class="pending-marker"
                title="awaiting moderation"
            >
                ·
            </span>
            <span v-if="msg.by_agent">by {{ msg.by_agent }}</span>
            <span class="spacer" />
            <span
                class="comment-date-copy"
                role="button"
                tabindex="0"
                :title="justCopied ? `copied ${commentRef}` : `Click to copy this comment's reference (${commentRef}) — ${msg.created_at}`"
                @click="copyRef"
                @keydown.enter.prevent="copyRef"
                @keydown.space.prevent="copyRef"
            >
                <i v-if="justCopied" class="pi pi-check comment-date-copy-icon" />
                {{ justCopied ? `copied ${commentRef}` : new Date(msg.created_at).toLocaleString() }}
            </span>
        </header>
        <div
            v-if="LIFECYCLE_LABELS[msg.kind]"
            class="comment-lifecycle"
            :data-kind="msg.kind"
        >
            <i :class="LIFECYCLE_LABELS[msg.kind].icon" />
            <span>{{ LIFECYCLE_LABELS[msg.kind].verb }}</span>
        </div>
        <MarkdownView v-if="msg.body || msg.edited_body" :source="msg.edited_body ?? msg.body" />
        <div v-if="msg.human_note" class="comment-note">
            <i class="pi pi-comment" />
            <em>{{ msg.human_note }}</em>
        </div>
        <div
            v-if="msg.status === 'pending' && msg.kind === 'comment_added'"
            class="comment-actions"
        >
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
    </div>
</template>
