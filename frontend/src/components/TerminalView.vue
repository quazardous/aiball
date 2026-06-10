<script setup lang="ts">
/**
 * #464 — read-only live mirror of an agent's tmux/psmux pane via SSE.
 *
 * Slice 1 shipped a plain `<pre>` rendering (`capture-pane -p`, no ANSI).
 * David `anz94c` : "du moment que le runtime js est en cache osef du
 * poids" → upgrade to real terminal rendering with xterm.js (~200KB
 * gzip). Backend now spawns `capture-pane -e -p` so ANSI escapes reach
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
// #472 david `5uwgev` : on réutilise les helpers de tag déjà partagés avec
// ConsumerEditPage / ProjectDetailPage pour rendre l'état claude-loop dans
// la barre du terminal — même rendu, pas de nouvelle barre.
import { activityClass, presenceClass, presenceWord } from "../lib/consumer-status";

const props = defineProps<{
    /** Consumer/agent id — the daemon constructs `cl-<name>` to target the
     *  claude-loop tmux session. */
    agentName: string;
    /** #472 david `5uwgev`/`fw9cpd` : claude-loop activity (boot/idle/busy)
     *  + human-presence word (stop/wait/ask/loop) + presence flag. Affichés
     *  comme ld-tags dans la barre du terminal pour que l'opérateur voie
     *  ce qui se passe sans switcher de tab. Optionnels — les tags ne se
     *  rendent que si fournis (ProjectDetailPage les pousse, n'importe
     *  quel autre futur conteneur peut juste passer null). */
    loopState?: string | null;
    humanPresent?: boolean | null;
    humanWord?: string | null;
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
//
// #472 david `fw9cpd` "parfois le terminal se refresh et on perd l'état
// d'édition" : ConsumerEditPage utilise `v-if="activeTab === 'terminal'"`
// pour lazy-mount le TerminalView → switcher d'onglet le démonte. Sans
// persistance, on revenait toujours en read-only + le confirm redemandait.
// On persiste les 2 refs dans sessionStorage scopé par agentName : la
// durée de vie est l'onglet du navigateur (pas localStorage qui survit
// aux fermetures de tab — la safety net du confirm reste alors valable
// la première fois qu'on ouvre l'agent dans un nouvel onglet).
const RW_KEY = `aiball.terminal.rw.${props.agentName}`;
const RW_CONFIRMED_KEY = `aiball.terminal.rwConfirmed.${props.agentName}`;
function readSession(key: string): boolean {
    try { return sessionStorage.getItem(key) === "1"; } catch { return false; }
}
function writeSession(key: string, v: boolean): void {
    try {
        if (v) sessionStorage.setItem(key, "1");
        else sessionStorage.removeItem(key);
    } catch { /* sessionStorage unavailable (private mode) — degrade gracefully */ }
}
const isReadWrite = ref<boolean>(readSession(RW_KEY));
const hasConfirmedRw = ref<boolean>(readSession(RW_CONFIRMED_KEY));
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
    /** #531 — actual cursor position in the pane (0-based), fetched server-side
     *  via `display-message #{cursor_x},#{cursor_y}` since the `capture-pane`
     *  snapshot doesn't always carry a positioning escape at its tail (psmux
     *  on Windows is one such case). Optional for backwards-compat. */
    cursor?: { x: number; y: number } | null;
}
interface PaneError {
    error: string;
    target?: string;
}

function mountTerm() {
    if (term || !containerRef.value) return;
    // Match the dark surface of the pre-xterm `.terminal-view__pane` so the
    // visual continuity across the rest of aiball admin pages stays intact.
    // #472 `fw9cpd` : si isReadWrite a été restauré true depuis sessionStorage
    // (switch d'onglet précédent), on instancie le Terminal déjà en mode RW —
    // sinon le watch ne fire pas (valeur inchangée) et le terminal reste en
    // disableStdin=true malgré le toggle visuel "on".
    const startRw = isReadWrite.value;
    term = new Terminal({
        convertEol: true,
        fontFamily: "ui-monospace, SFMono-Regular, 'Courier New', monospace",
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: startRw,
        disableStdin: !startRw,
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

// #747 — AFK toggle on the loop, bypassing the keystroke layer (F9
// inaccessible on touch / mobile). POSTs to the daemon's dedicated
// endpoint which writes <sd>/afk directly ; claude-loop picks it up
// via heartbeat within ~1s.
async function postAfkAction(action: "toggle" | "off" | "arm_10m" | "arm_inf") {
    try {
        const token = localStorage.getItem("aiball.token");
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (token) headers.authorization = `Bearer ${token}`;
        const res = await fetch(
            `/api/agents/${encodeURIComponent(props.agentName)}/afk`,
            { method: "POST", headers, body: JSON.stringify({ action }) },
        );
        if (!res.ok) {
            const text = await res.text();
            sendError.value = `afk ${res.status} : ${text}`;
        } else {
            sendError.value = null;
        }
    } catch (e) {
        sendError.value = (e as Error).message;
    }
}

// #907 — Start AFK = action "off" (= clear NOT-AFK hold = back to
// AFK ON = claude autonomous mode). Mirrors the legacy `resetAfkRemote`
// from #871.
async function startAfkRemote() { await postAfkAction("off"); }

// #907 — Stop AFK = action "arm_inf" (= david at controls indefinitely,
// claude pauses). The 10m intermediate is dropped from the UI ;
// F9 in the pane keeps cycling through if needed.
async function stopAfkRemote() { await postAfkAction("arm_inf"); }

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
    // #472 david `fw9cpd` : persist across tab switches (sessionStorage scoped).
    writeSession(RW_KEY, rw);
    if (!term) return;
    term.options.disableStdin = !rw;
    term.options.cursorBlink = rw;
    if (rw) {
        // Focus the terminal so a fresh toggle "just works" without an
        // extra click.
        try { term.focus(); } catch { /* noop */ }
    }
});
watch(hasConfirmedRw, (v) => writeSession(RW_CONFIRMED_KEY, v));

function applyFrame(text: string, cursor?: { x: number; y: number } | null) {
    if (!term) return;
    // Snapshot semantics : the whole visible pane lands every tick. Reset
    // wipes the screen + scrollback + cursor + colour state, then write
    // re-paints the snapshot. Accumulating would balloon the buffer.
    term.reset();
    term.write(text);
    // #531 — re-position the cursor to where the pane actually has it.
    // `capture-pane -e -p` on psmux (Windows) does not emit a positioning
    // escape at the tail, so without this step the cursor lands wherever
    // `term.write` left it (= end of the last char of the snapshot, not
    // the real claude prompt position). xterm.js uses 1-based CSI rows
    // and columns, our server payload is 0-based — hence the +1 offset.
    // tmux (Linux/macOS) does emit a positioning tail, so this just
    // re-affirms the position it already moved to (idempotent).
    if (cursor && typeof cursor.x === "number" && typeof cursor.y === "number") {
        term.write(`\x1b[${cursor.y + 1};${cursor.x + 1}H`);
    }
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
            applyFrame(frame.text, frame.cursor);
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
    // #503 — backend ouvre la SSE, envoie 1 event `unavailable` puis close
    // pour signaler qu'on ne peut pas servir ce pane localement (node-relayé,
    // pane sur un autre host). On affiche le message + on ferme proprement
    // pour ne pas reconnecter en boucle.
    es.addEventListener("unavailable", (e: MessageEvent) => {
        try {
            const data = JSON.parse(e.data) as { error?: string };
            lastError.value = data.error ?? "pane unavailable on this daemon";
        } catch {
            lastError.value = "pane unavailable on this daemon";
        }
        closeStream();
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

async function settleAndFit(): Promise<void> {
    // #533 (david repro claude-in-chrome Win DPI 1.25) — chicken-egg
    // mesure : canvas xterm conserve sa taille fullscreen tant que pas
    // de term.resize() explicite, push le wrapper, fit() lit la mauvaise
    // hauteur. Belt-and-suspenders :
    //  1. CSS `max-height: 22rem` sur `.terminal-view__xterm` borne le
    //     wrapper (cf style block). Override `max-height: none` en
    //     fullscreen.
    //  2. JS ici : avant `fit()`, on PRÉ-SHRINK le terminal à 80x24 quand
    //     on sort de fullscreen → casse le chicken-egg, le wrapper
    //     collapse à son min-height, fit() mesure correctement la nouvelle
    //     hauteur. Pré-shrink uniquement sur exit (entry fullscreen est
    //     déjà une croissance, fit() catch sans assistance).
    //  3. nextTick + RAF avant fit() pour laisser Vue + browser settle.
    //  4. scrollToBottom : si rows-count shrinke (60→24), garde le contenu
    //     récent visible au lieu du scrollback haut (vide-en-bas perçu).
    if (!isFullscreen.value) {
        try { term?.resize(80, 24); } catch { /* noop */ }
    }
    await nextTick();
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    fitAddon?.fit();
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    fitAddon?.fit();
    term?.scrollToBottom();
}

async function toggleFullscreen() {
    isFullscreen.value = !isFullscreen.value;
    await settleAndFit();
}

function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && isFullscreen.value) {
        isFullscreen.value = false;
        // #533 : même pattern que toggleFullscreen, l'Escape sortait
        // précédemment avec juste nextTick + fit (héritage du fix #472
        // incomplet pour ce path).
        settleAndFit();
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
            <!-- #472 david `5uwgev` : claude-loop activity + presence word
                 affichés ici (mêmes ld-tags qu'ailleurs) — pas de nouvelle
                 barre. Render-conditional : sans loopState fourni par le
                 parent on n'affiche rien. -->
            <template v-if="loopState">
                <span class="ld-tag" :class="activityClass(loopState)">{{ loopState }}</span>
                <span
                    v-if="humanWord || humanPresent != null"
                    class="ld-tag"
                    :class="presenceClass(humanPresent ?? null, humanWord ?? null)"
                >{{ presenceWord(humanPresent ?? null, humanWord ?? null) }}</span>
            </template>
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
            <!-- #871 — icon-only toolbar (drop labels). Tooltips + aria-label keep
                 the discoverability story for new users / screen readers. -->
            <Button
                :icon="isReadWrite ? 'pi pi-pencil' : 'pi pi-lock'"
                :severity="isReadWrite ? 'success' : 'secondary'"
                size="small"
                text
                rounded
                :aria-label="isReadWrite ? 'Disable typing into the pane (back to read-only)' : 'Enable typing into the pane (read-write)'"
                :title="isReadWrite
                    ? 'Read-write mode active — your keys reach the agent tmux pane. Click to lock back.'
                    : 'Read-only mode — click to unlock typing (confirm prompt)'"
                @click="toggleReadWrite"
            />
            <!-- #907 `zsekxt` — bare icon, no Button shell. Hover = color
                 shift on the glyph itself (no background, no border). -->
            <i
                class="pi pi-play afk-icon afk-icon--start"
                role="button"
                tabindex="0"
                aria-label="Start AFK (= claude autonomous mode)"
                title="Start AFK — claude runs alone (= autonomous, default)"
                @click="startAfkRemote"
                @keydown.enter.space.prevent="startAfkRemote"
            />
            <i
                class="pi pi-stop afk-icon afk-icon--stop"
                role="button"
                tabindex="0"
                aria-label="Stop AFK (= take over, NOT AFK indefinitely)"
                title="Stop AFK — take over the session (NOT AFK ∞, claude pauses indefinitely)"
                @click="stopAfkRemote"
                @keydown.enter.space.prevent="stopAfkRemote"
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
/* #907 `zsekxt` david : bare-glyph AFK icons, no button shell. */
.afk-icon {
    cursor: pointer;
    color: var(--p-text-muted-color);
    font-size: 1rem;
    padding: 0.2rem;
    transition: color 0.12s;
    user-select: none;
    outline: none;
}
.afk-icon:hover, .afk-icon:focus-visible {
    color: var(--p-text-color);
}
.afk-icon--start:hover, .afk-icon--start:focus-visible {
    color: var(--p-green-500);
}
.afk-icon--stop:hover, .afk-icon--stop:focus-visible {
    color: var(--p-red-500);
}
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
    /* #533 (david repro Win DPI 1.25 — chicken-egg) : `min-height` seul ne
       suffit pas — au sortir de fullscreen le canvas xterm garde sa taille
       fullscreen (629px observé), push le wrapper, et `fit()` mesure ce
       wrapper grow → pas de shrink. `max-height` capé borne le wrapper, et
       `overflow: hidden` empêche le canvas de déborder visiblement (xterm
       gère son propre scroll interne). En fullscreen ces deux contraintes
       sont relâchées (cf override ci-dessous). */
    min-height: 22rem;
    max-height: 22rem;
    overflow: hidden;
    padding: 0.4rem;
    background: #0f172a;
}
.terminal-view--fullscreen .terminal-view__xterm {
    min-height: 0;
    max-height: none;
}
</style>
