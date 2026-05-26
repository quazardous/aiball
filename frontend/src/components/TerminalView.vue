<script setup lang="ts">
/**
 * #464 — read-only live mirror of an agent's tmux/psmux pane via SSE.
 *
 * Slice 1 shipped a plain `<pre>` rendering (`capture-pane -p`, no ANSI).
 * David `anz94c` : "du moment que le runtime js est en cache osef du
 * poids" → upgrade to real terminal rendering with xterm.js (~200KB
 * gzip). Backend now spawns `capture-pane -ep` so ANSI escapes reach
 * the browser ; here we feed them into a real `Terminal` instance.
 *
 * Each SSE frame carries the FULL visible pane (capture-pane is a
 * snapshot, not a delta). To render it we reset the terminal then
 * write the snapshot — never accumulate, the buffer would grow
 * unbounded otherwise.
 *
 * Fullscreen toggle (CSS `position: fixed` + ESC) per david `6gh3g8`.
 * FitAddon resizes the terminal to the container on mount + on each
 * fullscreen toggle. The terminal only exists while this component
 * is mounted — `term.dispose()` on unmount frees its WebGL / canvas.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Button from "primevue/button";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const props = defineProps<{
    /** Consumer/agent id — the daemon constructs `cl-<name>` to target the
     *  claude-loop tmux session. */
    agentName: string;
}>();

const containerRef = ref<HTMLDivElement | null>(null);
const lastError = ref<string | null>(null);
const connected = ref<boolean>(false);
const lastCapturedAt = ref<string | null>(null);
const truncated = ref<boolean>(false);
const isFullscreen = ref<boolean>(false);

let es: EventSource | null = null;
let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
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

function mountTerm() {
    if (term || !containerRef.value) return;
    // Match the dark surface of the pre-xterm `.terminal-view__pane` so the
    // visual continuity across the rest of aiball admin pages stays intact.
    term = new Terminal({
        convertEol: true,
        fontFamily: "ui-monospace, SFMono-Regular, 'Courier New', monospace",
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: false,
        disableStdin: true, // read-only ; slice 2 would flip this for keystrokes
        scrollback: 0,      // capture-pane is a snapshot, scrollback isn't meaningful
        theme: {
            background: "#0f172a",     // ~ var(--p-surface-900)
            foreground: "#f8fafc",     // ~ var(--p-surface-0)
            cursor: "#f8fafc",
            black: "#1e293b",
            red: "#ef4444",
            green: "#22c55e",
            yellow: "#eab308",
            blue: "#3b82f6",
            magenta: "#a855f7",
            cyan: "#06b6d4",
            white: "#f8fafc",
            brightBlack: "#475569",
            brightRed: "#f87171",
            brightGreen: "#4ade80",
            brightYellow: "#facc15",
            brightBlue: "#60a5fa",
            brightMagenta: "#c084fc",
            brightCyan: "#22d3ee",
            brightWhite: "#ffffff",
        },
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.value);
    fitAddon.fit();
}

function disposeTerm() {
    if (term) {
        try { term.dispose(); } catch { /* noop */ }
        term = null;
    }
    fitAddon = null;
}

function applyFrame(text: string) {
    if (!term) return;
    // Snapshot semantics : the whole visible pane lands every tick. Reset
    // wipes the screen + scrollback + cursor + colour state, then write
    // re-paints the snapshot. Accumulating would balloon the buffer.
    term.reset();
    term.write(text);
}

function openStream() {
    closeStream();
    lastError.value = null;
    const token = localStorage.getItem("aiball.token");
    const tokenQs = token ? `?token=${encodeURIComponent(token)}` : "";
    const url = `/api/agents/${encodeURIComponent(props.agentName)}/pane/stream${tokenQs}`;
    es = new EventSource(url);
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
    };
    es.onmessage = (e) => {
        try {
            const frame = JSON.parse(e.data) as PaneFrame;
            applyFrame(frame.text);
            lastCapturedAt.value = frame.captured_at;
            truncated.value = !!frame.truncated;
            lastError.value = null;
        } catch {
            /* ignore malformed frame */
        }
    };
    es.addEventListener("error", (e: MessageEvent) => {
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

async function toggleFullscreen() {
    isFullscreen.value = !isFullscreen.value;
    // Wait a frame for the CSS resize to land, then re-fit the terminal so
    // its cells fill the new viewport (otherwise the bottom rows clip).
    await nextTick();
    fitAddon?.fit();
}

function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && isFullscreen.value) {
        isFullscreen.value = false;
        nextTick().then(() => fitAddon?.fit());
    }
}

function onWindowResize() {
    fitAddon?.fit();
}

const statusLabel = computed(() => {
    if (lastError.value) return `error : ${lastError.value}`;
    if (!connected.value) return "connecting…";
    if (lastCapturedAt.value) {
        return `live · last frame ${new Date(lastCapturedAt.value).toLocaleTimeString()}`;
    }
    return "live";
});

onMounted(async () => {
    await nextTick();
    mountTerm();
    openStream();
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("resize", onWindowResize);
});
onBeforeUnmount(() => {
    closeStream();
    disposeTerm();
    window.removeEventListener("keydown", onKeydown);
    window.removeEventListener("resize", onWindowResize);
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
            <span
                class="terminal-view__status"
                :class="{ 'terminal-view__status--error': !!lastError, 'terminal-view__status--live': connected && !lastError }"
            >
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
        <div ref="containerRef" class="terminal-view__xterm" />
    </div>
</template>

<style scoped>
.terminal-view {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.4rem;
    overflow: hidden;
    background: #0f172a;
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
    background: #1e293b;
    border-bottom: 1px solid #334155;
    font-size: 0.85rem;
    color: #f8fafc;
}
.terminal-view__title {
    font-family: ui-monospace, SFMono-Regular, monospace;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
}
.terminal-view__status {
    color: #94a3b8;
    font-size: 0.8rem;
    font-style: italic;
    margin-left: auto;
}
.terminal-view__status--live {
    color: #4ade80;
    font-style: normal;
}
.terminal-view__status--error {
    color: #f87171;
    font-style: normal;
}
.terminal-view__warn {
    color: #fbbf24;
    font-size: 0.8rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
}
.terminal-view__xterm {
    flex: 1;
    min-height: 22rem;
    padding: 0.4rem;
    background: #0f172a;
    /* xterm.js puts its own canvas inside this div ; just give it room. */
}
.terminal-view--fullscreen .terminal-view__xterm {
    min-height: 0;
}
</style>
