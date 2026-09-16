<script setup lang="ts">
/**
 * #2653 — the commits a comment said it delivers (#2652), under its buttons:
 * one chip per commit (short SHA, the wait credit it earned or why not), linked
 * to the commit when the project has a GitHub repository bound, otherwise a
 * click copies the SHA. A discreet "no commit" when the agent said none;
 * nothing when the comment never said.
 */
import { computed, ref } from "vue";
import Tag from "primevue/tag";
import type { Message } from "../lib/api";
import { commitsView } from "../lib/commentCommits";
import { resolveCommitUrl, upstreamBindings } from "../lib/upstream-providers";

const props = defineProps<{ msg: Message }>();
const copied = ref<string | null>(null);

const view = computed(() => commitsView(props.msg.meta, (sha) => resolveCommitUrl(sha, upstreamBindings.value[props.msg.project] ?? [])));

async function copy(sha: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(sha);
        copied.value = sha;
        setTimeout(() => { if (copied.value === sha) copied.value = null; }, 1500);
    } catch {
        // No clipboard (insecure context): the full SHA stays in the tooltip.
    }
}
</script>

<template>
    <div v-if="view.state !== 'absent'" class="comment-commits">
        <span v-if="view.state === 'none'" class="comment-commits__none" title="The agent said this comment delivers no commit">no commit</span>
        <template v-else>
            <component
                :is="chip.url ? 'a' : 'span'"
                v-for="chip in view.chips"
                :key="chip.sha"
                class="comment-commits__chip"
                :href="chip.url ?? undefined"
                :target="chip.url ? '_blank' : undefined"
                :rel="chip.url ? 'noopener noreferrer' : undefined"
                :title="chip.title"
                :role="chip.url ? undefined : 'button'"
                @click="chip.url ? undefined : copy(chip.sha)"
            >
                <Tag
                    :severity="chip.earned ? 'success' : 'secondary'"
                    style="font-size: var(--fs-2xs)"
                >
                    <i class="pi pi-code" style="font-size: var(--fs-2xs)" />
                    <code class="comment-commits__sha">{{ copied === chip.sha ? "copied" : chip.short }}</code>
                    <span class="comment-commits__credit">{{ chip.credit }}</span>
                </Tag>
            </component>
        </template>
    </div>
</template>

<style scoped>
.comment-commits {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.25rem;
}
.comment-commits__chip {
    text-decoration: none;
    cursor: pointer;
}
.comment-commits__sha {
    margin: 0 0.3rem;
}
.comment-commits__credit {
    opacity: 0.8;
}
.comment-commits__none {
    font-size: var(--fs-2xs);
    opacity: 0.45;
}
</style>
