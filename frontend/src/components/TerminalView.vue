<script setup lang="ts">
/**
 * #464 — read-only live mirror of an agent's tmux/psmux pane. Subscribes
 * to the daemon's `GET /api/agents/:name/pane/stream` SSE endpoint and
 * renders the captured text in a `<pre>`. Fullscreen toggle (`position:
 * fixed` + ESC handler) per david `6gh3g8`.
 *
 * Plain-text only — slice 1. ANSI escapes are NOT requested from the
 * backend (`-p` not `-ep`), so the rendering stays homogeneous across
 * tmux + psmux and doesn't need xterm.js. Slice 2+ can wire in colours
 * + a real terminal emulator if needed.
 *
 * The SSE connection only opens when the component is mounted, and closes
 * on unmount — so wrapping the component in a lazily-rendered tab body
 * (the ConsumerEditPage pattern) ensures the daemon doesn't spawn a
 * capture-pane every 1s for every Browser tab that has /consumers open.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Button from "primevue/button";

const props = defineProps<{
    /** Consumer/agent id — the daemon constructs `cl-<name>` to target the
     *  claude-loop tmux session. */
    agentName: string;
}>();

const text = ref<string>("");
const lastError = ref<string | null>(null);
const connected = ref<boolean>(false);
const lastCapturedAt = ref<string | null>(null);
const truncated = ref<boolean>(false);
const isFullscreen = ref<boolean>(false);

let es: EventSource | null = null;
let connectTimeoutId: number | null = null;

interface PaneFrame {
    text: string;
    target: string;
    truncated?: boolean;
    captured_at: string;
}
interface PaneError {
    error: string;
    target?: string;
}

function openStream() {
    closeStream();
    lastError.value = null;
    // #464 — EventSource can't set custom headers (no `Authorization`),
    // so we pass the bearer via `?token=` query string. The backend's
    // `readBearerToken` accepts it as a last-resort fallback (auth.ts).
    // Cookies / same-origin alone aren't enough today : aiball's daemon
    // auth model is bearer-only, no session cookie.
    const token = localStorage.getItem("aiball.token");
    const tokenQs = token ? `?token=${encodeURIComponent(token)}` : "";
    const url = `/api/agents/${encodeURIComponent(props.agentName)}/pane/stream${tokenQs}`;
    es = new EventSource(url);
    // If we never see an `open` within 5s, surface a clearer message so the
    // user isn't stuck staring at "connecting…" forever (e.g. auth fail,
    // backend not running, cwd mismatch). EventSource itself only fires a
    // generic `error` event without a status code in that case.
    connectTimeoutId = window.setTimeout(() => {
        if (!connected.value && !lastError.value) {
            lastError.value = "no response from server (check auth / loop)";
        }
    }, 5000);
    es.onopen = () => {
        connected.value = true;
        if (connectTimeoutId !== null) {
            clearTimeout(connectTimeoutId);
            connectTimeoutId = null;
        }
    };
    es.onerror = () => {
        connected.value = false;
        // EventSource auto-reconnects per the server's `retry:` hint.
        // We only surface a message if it stays disconnected long enough
        // to warrant one — the browser handles transient drops gracefully.
    };
    es.onmessage = (e) => {
        try {
            const frame = JSON.parse(e.data) as PaneFrame;
            text.value = frame.text;
            lastCapturedAt.value = frame.captured_at;
            truncated.value = !!frame.truncated;
            lastError.value = null;
        } catch {
            /* ignore malformed frame */
        }
    };
    es.addEventListener("error", (e: MessageEvent) => {
        // Server-sent `event: error` — distinct from EventSource's onerror
        // (network) and surfaced inline in the UI.
        try {
            const data = JSON.parse(e.data) as PaneError;
            lastError.value = data.error;
        } catch {
            /* ignore malformed error frame */
        }
    });
}

function closeStream() {
    if (es) {
        try { es.close(); } catch { /* noop */ }
        es = null;
    }
    if (connectTimeoutId !== null) {
        clearTimeout(connectTimeoutId);
        connectTimeoutId = null;
    }
    connected.value = false;
}

function toggleFullscreen() {
    isFullscreen.value = !isFullscreen.value;
}

function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && isFullscreen.value) {
        isFullscreen.value = false;
    }
}

const statusLabel = computed(() => {
    if (lastError.value) return `error : ${lastError.value}`;
    if (!connected.value) return "connecting…";
    if (lastCapturedAt.value) {
        return `live · last frame ${new Date(lastCapturedAt.value).toLocaleTimeString()}`;
    }
    return "live";
});

onMounted(() => {
    openStream();
    window.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
    closeStream();
    window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
    <div
        class="terminal-view"
        :class="{ 'terminal-view--fullscreen': isFullscreen }"
    >
        <div class="terminal-view__bar">
            <span class="terminal-view__title">
                <i class="pi pi-desktop" />
                <code>cl-{{ agentName }}</code>
            </span>
            <span class="terminal-view__status" :class="{ 'terminal-view__status--error': !!lastError, 'terminal-view__status--live': connected && !lastError }">
                {{ statusLabel }}
            </span>
            <span v-if="truncated" class="terminal-view__warn">
                <i class="pi pi-exclamation-triangle" /> truncated
            </span>
            <Button
                :icon="isFullscreen ? 'pi pi-window-minimize' : 'pi pi-window-maximize'"
                size="small"
                text
                rounded
                :aria-label="isFullscreen ? 'Exit fullscreen' : 'Fullscreen'"
                @click="toggleFullscreen"
            />
        </div>
        <pre class="terminal-view__pane">{{ text || "(no content yet — waiting for first capture…)" }}</pre>
    </div>
</template>

<style scoped>
.terminal-view {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.4rem;
    overflow: hidden;
    background: var(--p-surface-900);
    color: var(--p-surface-0);
}
.terminal-view--fullscreen {
    position: fixed;
    inset: 0;
    z-index: 999;
    border-radius: 0;
    border: none;
}
.terminal-view__bar {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    padding: 0.4rem 0.6rem;
    background: var(--p-surface-800);
    border-bottom: 1px solid var(--p-surface-700);
    font-size: 0.85rem;
}
.terminal-view__title {
    font-family: ui-monospace, SFMono-Regular, monospace;
    color: var(--p-surface-0);
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
}
.terminal-view__status {
    color: var(--p-surface-300);
    font-size: 0.8rem;
    font-style: italic;
    margin-left: auto;
}
.terminal-view__status--live {
    color: var(--p-green-400);
    font-style: normal;
}
.terminal-view__status--error {
    color: var(--p-red-400);
    font-style: normal;
}
.terminal-view__warn {
    color: var(--p-orange-400);
    font-size: 0.8rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
}
.terminal-view__pane {
    margin: 0;
    padding: 0.8rem 1rem;
    font-family: ui-monospace, SFMono-Regular, "Courier New", monospace;
    font-size: 0.85rem;
    line-height: 1.35;
    white-space: pre;
    overflow: auto;
    flex: 1;
    min-height: 22rem;
    /* Avoid coloured selection looking weird on a dark bg. */
    color: var(--p-surface-0);
    background: var(--p-surface-900);
}
.terminal-view--fullscreen .terminal-view__pane {
    /* Fill the viewport — the fixed-positioned wrapper has no height
       constraint so the pane needs to claim it explicitly. */
    min-height: 0;
}
</style>
