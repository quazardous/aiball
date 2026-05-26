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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import { useConfirm } from "primevue/useconfirm";
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
// #472 — read-write mode toggle. Default OFF (read-only) so the user can't
// accidentally type into a live claude session just by focusing the
// browser tab. The toggle is a labeled button ("Enable typing" / "Disable
// typing") rather than a bare icon, and the FIRST activation per mount is
// gated by a ConfirmDialog — david `98veqc` : "se débloque avec un toggle"
// → make the unlock deliberate, not a stray click. Subsequent toggles
// within the same tab session bypass the confirm (it's a safety net for
// the first time, not a per-click prompt).
const isReadWrite = ref<boolean>(false);
const hasConfirmedRw = ref<boolean>(false);
const sendError = ref<string | null>(null);

const confirmDialog = useConfirm();

let es: EventSource | null = null;
let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let connectTimeoutId: number | null = null;
let dataDisposer: { dispose(): void } | null = null;

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

    // #472 — register a single onData handler. xterm fires this on every
    // user keystroke (printable chars, control sequences, paste, etc.) when
    // `disableStdin` is false. The handler gates on `isReadWrite` so flipping
    // the toggle is purely a re-bind of the disableStdin flag — the handler
    // doesn't have to be added/removed. POSTs the raw bytes to the daemon's
    // `send-keys` endpoint, which pipes them through `tmux send-keys -l`.
    dataDisposer = term.onData((data) => {
        if (!isReadWrite.value) return;
        void postKeys(data);
    });
}

function disposeTerm() {
    if (dataDisposer) {
        try { dataDisposer.dispose(); } catch { /* noop */ }
        dataDisposer = null;
    }
    if (term) {
        try { term.dispose(); } catch { /* noop */ }
        term = null;
    }
    fitAddon = null;
}

async function postKeys(data: string) {
    try {
        const token = localStorage.getItem("aiball.token");
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (token) headers.authorization = `Bearer ${token}`;
        const res = await fetch(
            `/api/agents/${encodeURIComponent(props.agentName)}/pane/keys`,
            { method: "POST", headers, body: JSON.stringify({ keys: data }) },
        );
        if (!res.ok) {
            const text = await res.text();
            sendError.value = `send-keys ${res.status} : ${text}`;
        } else {
            sendError.value = null;
        }
    } catch (e) {
        sendError.value = (e as Error).message;
    }
}

function toggleReadWrite() {
    if (isReadWrite.value) {
        // Disabling : no confirm — going BACK to safe (read-only) is fine.
        isReadWrite.value = false;
        return;
    }
    // Enabling. Confirm once per mount, then unlocked freely for the rest
    // of the tab session. If the operator re-opens the tab (component
    // re-mount), the confirm is asked again.
    if (hasConfirmedRw.value) {
        isReadWrite.value = true;
        return;
    }
    confirmDialog.require({
        header: "Enable typing into the terminal",
        message: `You're about to enable typing into ${props.agentName}'s live claude-loop tmux session. Every keystroke you type — including Ctrl-C, Enter, paste — will be sent to the running session. Continue ?`,
        icon: "pi pi-pencil",
        acceptLabel: "Enable typing",
        rejectLabel: "Cancel",
        acceptClass: "p-button-warning",
        accept: () => {
            hasConfirmedRw.value = true;
            isReadWrite.value = true;
        },
    });
}

// xterm's `disableStdin` swallow input at the terminal layer, so the toggle
// directly drives the live behavior : RW on → terminal accepts keys + onData
// fires + we POST ; RW off → terminal eats every keypress + onData stays
// silent + nothing reaches the agent. The cursor visibility tracks RW too
// (no blinking caret in read-only mode → clear visual signal).
watch(isReadWrite, (rw) => {
    if (!term) return;
    term.options.disableStdin = !rw;
    term.options.cursorBlink = rw;
    if (rw) {
        // Focus the terminal so a fresh toggle "just works" without an
        // extra click.
        try { term.focus(); } catch { /* noop */ }
    }
});

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
            <span v-if="sendError" class="terminal-view__warn" :title="sendError">
                <i class="pi pi-exclamation-triangle" /> send-keys failed
            </span>
            <!-- #472 — read-write toggle. David `98veqc` "se débloque avec
                 un toggle" → labeled button (not bare icon) + ConfirmDialog
                 on the first activation per mount. Subsequent flips bypass
                 the confirm (it's a safety net for the deliberate unlock,
                 not a per-click prompt). -->
            <Button
                :icon="isReadWrite ? 'pi pi-pencil' : 'pi pi-lock'"
                :label="isReadWrite ? 'Disable typing' : 'Enable typing'"
                :severity="isReadWrite ? 'success' : 'secondary'"
                size="small"
                :outlined="!isReadWrite"
                :aria-label="isReadWrite ? 'Disable typing into the pane (back to read-only)' : 'Enable typing into the pane (read-write)'"
                :title="isReadWrite
                    ? 'Read-write mode active — your keys reach the agent tmux pane. Click to lock back.'
                    : 'Read-only mode — click to unlock typing (confirm prompt)'"
                @click="toggleReadWrite"
            />
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
