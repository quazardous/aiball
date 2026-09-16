<script setup lang="ts">
/**
 * #2653 — the commits a comment said it delivers (#2652), under its buttons.
 * #2663 david — discreet: a small muted line of short SHAs, no tag, no score;
 * linked to the commit when the project has a GitHub repository bound,
 * otherwise a click copies the SHA. No commit (none said, or never said):
 * nothing is rendered at all.
 */
import { computed, ref } from "vue";
import type { Message } from "../lib/api";
import { commitsView } from "../lib/commentCommits";
import { resolveCommitUrl, upstreamBindings } from "../lib/upstream-providers";

const props = defineProps<{ msg: Message }>();
const copied = ref<string | null>(null);

const chips = computed(() => {
    const v = commitsView(props.msg.meta, (sha) => resolveCommitUrl(sha, upstreamBindings.value[props.msg.project] ?? []));
    return v.state === "list" ? v.chips : [];
});

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
    <div v-if="chips.length" class="comment-commits">
        <template v-for="(chip, i) in chips" :key="chip.sha">
            <span v-if="i > 0" class="comment-commits__sep">·</span>
            <a
                v-if="chip.url"
                class="comment-commits__sha"
                :href="chip.url"
                target="_blank"
                rel="noopener noreferrer"
                :title="chip.title"
            >{{ chip.short }}</a>
            <span
                v-else
                class="comment-commits__sha comment-commits__sha--copy"
                role="button"
                tabindex="0"
                :title="chip.title"
                @click="copy(chip.sha)"
                @keydown.enter.prevent="copy(chip.sha)"
            >{{ copied === chip.sha ? "copied" : chip.short }}</span>
        </template>
    </div>
</template>

<style scoped>
.comment-commits {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.3rem;
    margin-top: 0.15rem;
    font-size: var(--fs-2xs);
    opacity: 0.55;
}
.comment-commits__sha {
    font-family: var(--font-mono, monospace);
    color: inherit;
    text-decoration: none;
}
.comment-commits__sha:hover {
    text-decoration: underline;
    opacity: 1;
}
.comment-commits__sha--copy {
    cursor: pointer;
}
</style>
