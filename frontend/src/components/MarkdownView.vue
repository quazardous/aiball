<script setup lang="ts">
import { computed } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";

const props = defineProps<{ source: string | null | undefined }>();

marked.setOptions({
    gfm: true,
    breaks: true,
});

const html = computed(() => {
    const src = props.source ?? "";
    if (!src) return "";
    const raw = marked.parse(src, { async: false }) as string;
    return DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: [
            "h1", "h2", "h3", "h4", "h5", "h6",
            "p", "br", "hr",
            "strong", "em", "del", "code", "pre",
            "blockquote",
            "ul", "ol", "li",
            "a", "img",
            "table", "thead", "tbody", "tr", "th", "td",
            "input", // gfm checkboxes
        ],
        ALLOWED_ATTR: ["href", "title", "alt", "src", "type", "checked", "disabled", "class"],
        ALLOW_DATA_ATTR: false,
    });
});
</script>

<template>
    <div class="md-body" v-html="html" />
</template>

<style>
.md-body {
    line-height: 1.5;
    word-wrap: break-word;
}
.md-body :first-child { margin-top: 0; }
.md-body :last-child { margin-bottom: 0; }
.md-body h1, .md-body h2, .md-body h3, .md-body h4, .md-body h5, .md-body h6 {
    margin: 0.6em 0 0.3em;
    line-height: 1.25;
    font-weight: 600;
}
.md-body h1 { font-size: 1.4em; }
.md-body h2 { font-size: 1.25em; }
.md-body h3 { font-size: 1.1em; }
.md-body p { margin: 0.4em 0; }
.md-body code {
    background: var(--p-surface-100);
    padding: 0.1em 0.35em;
    border-radius: 0.2rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
}
.aiball-dark .md-body code { background: var(--p-surface-800); }
.md-body pre {
    background: var(--p-surface-100);
    padding: 0.6em 0.8em;
    border-radius: 0.3rem;
    overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
}
.aiball-dark .md-body pre { background: var(--p-surface-800); }
.md-body pre > code {
    background: transparent;
    padding: 0;
}
.md-body blockquote {
    border-left: 3px solid var(--p-content-border-color);
    padding-left: 0.8em;
    color: var(--p-text-muted-color);
    margin: 0.4em 0;
}
.md-body ul, .md-body ol { padding-left: 1.4em; margin: 0.4em 0; }
.md-body table { border-collapse: collapse; }
.md-body th, .md-body td {
    border: 1px solid var(--p-content-border-color);
    padding: 0.3em 0.6em;
}
.md-body a { color: var(--p-primary-color); }
.md-body img { max-width: 100%; }
.md-body hr {
    border: none;
    border-top: 1px solid var(--p-content-border-color);
    margin: 0.8em 0;
}
</style>
