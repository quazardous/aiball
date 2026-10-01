/**
 * #862 (`s8u6pt`) — BarRenderer: the single writer of the tmux bar.
 *
 * It watches `ipcState`: subscribes to `onIpcChanged`, debounces 50 ms,
 * computes the bar's desired state from `getIpcState()` + `computeLoopView`,
 * diffs it against the last snapshot it painted, and writes only the tmux
 * options that changed. A 1 s safety tick catches what only time changes (a
 * typing glyph expiring, the hold countdown).
 *
 * **Public API = `start()` / `stop()`.** Other modules do not know it exists:
 * they mutate state through `setIpc*`, and the bar follows.
 *
 * History: slice 1 only observed, logging its snapshot next to the legacy
 * paints; slice 3 made it the writer and neutralised those paints
 * (`setTmuxStatus` / `setTmuxCounters` / `setTmuxAfkState`). #2311 — this
 * header still described slice 1.
 */
import { modelShortName } from "../model-name.js";
import { spawnSync } from "node:child_process";
import { muxQueue } from "./mux-async.js";
import { existsSync } from "node:fs";
import { getIpcState, onIpcChanged } from "./ipc-state.js";
import {
    MUX_CMD,
    afkGlyphChunk,
    barColors,
    humanPresenceChunk,
    humanIsTyping,
    typingGlyphChunk,
    logBarPaint,
    proxyIsAlive,
    readBarHost,
    readLoopStateInput,
    stateBg,
    tmuxName,
    zenPath,
    LOOP_STATUS,
    type LoopStatus,
} from "./state.js";
import { computeLoopView } from "./loop-state.js";
import { afkState, COPY_MARK } from "./bar-render.js";
import { attachFor, type AgentBar, type BarHost } from "../agent-bar.js";
import { CL_ENV } from "./env-vars.js";

/** Snapshot canonical de la barre tmux. Chaque champ correspond à une
 *  tmux user-option / propriété peinte par les writers actuels. Pur
 *  data — la classe diff snapshot vs lastObserved pour décider quoi
 *  repaint (Slice 3+). */
export interface BarSnapshot {
    /** `@cl_human` : le mot human-presence (loop/wait/stop/boot) avec
     *  color tags ; reflète `view.barWord` post-computeLoopView. */
    humanWord: string;
    /** Loop status canonique (boot/idle/busy) — drive le bg color de
     *  la bar et le tag `[status]`. */
    loopStatus: LoopStatus;
    /** `@cl_state` (le tag `[busy]` / `[idle:wait]`) */
    stateTag: string;
    /** Proxy alive ? Drives `@cl_proxy` (⇄ / empty). */
    proxyAlive: boolean;
    /** Zen mode actif ? (fichier `zen` présent — par décision de david
     *  #856 zen reste fichier-based, exception au IPC-only #840). */
    zenActive: boolean;
    /** `@cl_counts` : counters ground truth depuis `ipc.counters`. Null
     *  = segment vide. Slice 2 ajoute le mirroring `setIpcCounters`
     *  côté timer ; Slice 3 fera du BarRenderer le SEUL writer. */
    counters: { open: number | null; backlog: number | null; events: number | null } | null;
    /** #805 — countdown vers le prochain `turn:settled` wake. `null` =
     *  pas idle / busy / unknown / pas d'event à drainer. Rendu après les
     *  counters comme `📨Ns`. */
    nextWakeInSec: number | null;
    /** #891 — boot elapsed et remaining (seconds). `null` hors boot.
     *  Rendus dans la zone compteurs comme `🚀Ns +Ns`, prioritaires
     *  sur nextWakeInSec. */
    bootElapsedSec: number | null;
    bootRemainingSec: number | null;
    /** #962 — `@cl_afk_glyph` : glyph bonhomme `웃` à la fin de la zone
     *  claude (status-left), coloré + suffix selon le mode AFK.
     *  Remplace `@cl_afk_state` (chip texte status-right) qui devient un
     *  literal statique `AFK:F9` dans le seed cmdStart. */
    afkGlyph: string;
    /** #953 david `<chat>` : glyphe `❯` quand la prompt-zone Claude
     *  Code est visible, peint AVANT le mot `claude` dans le bloc
     *  fond noir. Empty quand absent. */
    promptGlyph: string;
    /** #953 david `<chat>` : glyphe `⌨` rouge quand le user tape
     *  activement. Indépendant du wait/loop — affiché en plus, pas
     *  en remplacement. Placé entre @cl_prompt et @cl_human. */
    typingGlyph: string;
    /** #1039 — proxy↔timer IPC link DOWN ? Default false = normal per-state
     *  bg (no separate "green"). True only on a CONFIRMED dead link → the bar
     *  bg is painted RED (error overlay). */
    linkDown: boolean;
    /** #1039 follow-up — loop↔daemon link DOWN ? Same RED overlay. The bar is
     *  red on `linkDown || daemonDown` (either critical peer lost). */
    daemonDown: boolean;
    /** #1072 — Claude Code not logged in ? Paints the bar ORANGE (colour208,
     *  PRIORITY over the RED link-down overlay) + a `/login` hint in the state
     *  tag. Cleared on the first Stop hook. */
    notLoggedIn: boolean;
    /** #3268 — a usage limit reached ? ORANGE, with the reset in the state tag. */
    limitReached: boolean;
    limitResetsText: string | null;
    /** #2230 — Claude Code's folder trust dialog on screen ? Same ORANGE
     *  overlay + an `attach to answer` hint. Cleared when the dialog goes. */
    trustDialog: boolean;
    /** #1116 — Claude Code can't reach the API (retry banner) ? Same ORANGE
     *  overlay + a `retrying` hint in the state tag. Cleared on busy-begin /
     *  Stop. */
    apiUnreachable: boolean;
}

/** #950 david `<chat>` : compose les tokens orthogonaux du marker
 *  segment en deux zones — d'abord les SYMBOLES (chaque genre une
 *  seule fois, ordre fixe), puis les WORD HINTS dans le même ordre.
 *  Drop des crochets / pipes / colon — tout est space-separated.
 *
 *  Genres (ordre fixe = ordre d'apparition dans la barre) :
 *
 *  | Genre   | Symbole | Sens                              | Membres aujourd'hui |
 *  |---------|---------|-----------------------------------|---------------------|
 *  | status  | 🚀/🧠/💤| boot / busy = réfléchit / idle = endormi | `boot`, `busy`, `idle` (mutex) |
 *  | warning | ⚠️      | condition erreur backend          | `retry N`           |
 *  | question| ❓      | input user attendu                | `resume`, `mode`, `health` |
 *  | process | 🔄      | long task interne                 | `compacting`, `resuming` |
 *  | plain   | —       | états internes ni l'un ni l'autre | `wait`, `interrupted` |
 *
 *  Layout : `[symboles dédupliqués, ordre fixe] [loopStatus] [warning_words] [question_words] [process_words] [plain_words]`
 *
 *  Exemples concrets :
 *  - idle nominal             → `💤`
 *  - busy nominal             → `🧠`
 *  - boot                     → `🚀`
 *  - idle + retry 3           → `💤 ⚠️ retry 3`
 *  - busy + compacting        → `🧠 🔄 compacting`
 *  - idle + resume + health   → `💤 ❓ resume health`
 *  - busy + retry 3 + health  → `🧠 ⚠️ ❓ retry 3 health`
 *  - boot + resume picker     → `🚀 ❓ resume`
 *
 *  Zone vit dans le bloc fond NOIR (colour16) à gauche, collée à
 *  `claude-loop`. Le caller (paint) gère fg/bg dans la format string. */
const LONG_TASKS: ReadonlySet<string> = new Set(["compacting", "resuming"]);

export function renderMarkerSegment(
    loopStatus: LoopStatus,
    info: string | null,
    healthPromptVisible: boolean,
    resumePickerActive: boolean,
    resumeModePickerActive: boolean,
): string {
    // Classify info into the right genre (warning / process / plain).
    const warningWord = info && /^retry /.test(info) ? info : null;
    const processWord = info && LONG_TASKS.has(info) ? info : null;
    const plainWord = info && !warningWord && !processWord ? info : null;
    const questionWords: string[] = [];
    if (resumePickerActive) questionWords.push("resume");
    if (resumeModePickerActive) questionWords.push("mode");
    if (healthPromptVisible) questionWords.push("health");

    // Symbols section — fixed order : status / warning / question / process.
    // 🚀/🧠/💤 sont mutex (loopStatus boot XOR busy XOR idle).
    // Le glyph prompt `❯` vit DEHORS de ce segment (avant `claude`,
    // david `<chat>` 2026-06-14) — paint séparé via `@cl_prompt`.
    const symbols: string[] = [];
    if (loopStatus === LOOP_STATUS.BOOT) symbols.push("🚀");
    else if (loopStatus === LOOP_STATUS.BUSY) symbols.push("🧠");
    else if (loopStatus === LOOP_STATUS.IDLE) symbols.push("💤");
    if (warningWord) symbols.push("⚠️");
    if (questionWords.length) symbols.push("❓");
    if (processWord) symbols.push("🔄");

    // Words section — same order : warning + question + process + plain.
    // Le loopStatus est désormais 100% couvert par les symboles.
    const words: string[] = [];
    if (warningWord) words.push(warningWord);
    if (questionWords.length) words.push(...questionWords);
    if (processWord) words.push(processWord);
    if (plainWord) words.push(plainWord);

    return [...symbols, ...words].join(" ");
}

/** Compute le snapshot canonique depuis ipcState + computeLoopView.
 *  Pure : pas de side-effect, pas de spawn tmux. */
export function computeBarSnapshot(sd: string): BarSnapshot {
    const input = readLoopStateInput(sd);
    const view = computeLoopView(input);
    const proxyAlive = proxyIsAlive(sd);
    const humanWord = humanPresenceChunk(sd);
    const loopStatus: LoopStatus = view.phase === "boot"
        ? LOOP_STATUS.BOOT
        : view.phase === "busy"
            ? LOOP_STATUS.BUSY
            : LOOP_STATUS.IDLE;
    const ipc = getIpcState();
    const stateTag = renderMarkerSegment(
        loopStatus,
        ipc.stateTagInfo,
        ipc.healthPromptVisible,
        ipc.resumeSessionPickerActive === true,
        ipc.resumeModePickerActive === true,
    );
    const zenActive = existsSync(zenPath(sd));
    const counters = ipc.counters;
    const afkGlyph = afkGlyphChunk(sd);
    // #891 — boot elapsed + remaining déplacés du state tag vers la zone
    // compteurs. Rendus `🚀Ns +Ns` (prioritaires).
    let bootElapsedSec: number | null = null;
    let bootRemainingSec: number | null = null;
    if (loopStatus === LOOP_STATUS.BOOT) {
        bootElapsedSec = Math.max(0, Math.floor((input.nowMs - input.loopStartMs) / 1000));
        if (ipc.bootDeadlineMs !== null) {
            const remMs = ipc.bootDeadlineMs - input.nowMs;
            if (remMs > 0) bootRemainingSec = Math.max(0, Math.ceil(remMs / 1000));
        }
    }
    // #805 / #919 / #999 / #1041 — countdown = temps avant le prochain drain.
    //
    // #1041 david `wk2mut` : la barre lit désormais `nextWakeAtMs` (armé par le
    // timer via `recomputeNextWake` — prochaine re-entrée `settled` RÉELLE, ré-armé
    // au ping SSE + à chaque snapshot turn). C'est une lecture in-process (la barre
    // tourne dans le même process que `ipc-state`) → coût nul, et on repaint déjà
    // 1×/s.
    //
    // Pourquoi remplacer l'ancien `idleSinceMs + WAKE_COOLDOWN_MS` : celui-ci ne
    // montrait le countdown que pendant la 1ʳᵉ fenêtre de grace après bascule idle
    // (modèle « FIFO + grace, puis pipe ouvert »). Or le modèle #999 draine en
    // TEMPO RÉCURRENTE (re-entrée `settled` toutes les `tempo`) ; le countdown
    // reflète maintenant ce vrai rythme au lieu de disparaître après 10s.
    // `nextWakeAtMs` est null exactement quand il n'y a rien à drainer (le gate
    // d'arming encode déjà idle + boot + pending) → pas de countdown inutile (#999).
    // On garde `view.phase === "idle"` pour ne pas afficher de countdown quand la
    // barre est busy. (Ancien refus `86fjp3` portait sur des gates loopStart/Turn
    // instables au reload ; ici on ne GATE pas dessus, on lit juste la valeur déjà
    // entretenue — au pire un trou ≤ tempo après respawn, couvert par le 📨 standing.)
    let nextWakeInSec: number | null = null;
    if (view.phase === "idle" && ipc.nextWakeAtMs !== null) {
        const remainingMs = ipc.nextWakeAtMs - input.nowMs;
        if (remainingMs > 0) nextWakeInSec = Math.ceil(remainingMs / 1000);
    }
    // #993 — `❯` orange when the prompt has unsent text, plain otherwise.
    // Restore island_fg right after so the downstream segments (typing /
    // human / ` claude`) render unchanged (the format sets island_fg before
    // `@cl_prompt`). Empty-but-visible stays plain (inherits island_fg).
    const promptGlyph = ipc.promptZoneVisible
        ? (ipc.promptHasInput ? `#[fg=${barColors().prompt_input_fg}]❯#[fg=${barColors().island_fg}]` : "❯")
        : "";
    const typingGlyph = typingGlyphChunk(sd);
    return {
        humanWord,
        loopStatus,
        stateTag,
        proxyAlive,
        zenActive,
        counters,
        nextWakeInSec,
        bootElapsedSec,
        bootRemainingSec,
        afkGlyph,
        promptGlyph,
        typingGlyph,
        linkDown: ipc.linkDown,
        daemonDown: ipc.daemonDown,
        notLoggedIn: ipc.notLoggedIn,
        limitReached: ipc.limitReached === true,
        limitResetsText: ipc.limitResets?.text ?? null,
        trustDialog: ipc.trustDialog,
        apiUnreachable: ipc.apiUnreachable,
    };
}

/**
 * #3030 — the same bar as DATA, for hosts other than tmux: read from the same
 * inputs as `computeBarSnapshot`, but facts instead of glyphs, and absolute
 * times instead of countdowns (see `agent-bar.ts`). `nowMs` is injectable for
 * tests.
 */
export function computeAgentBar(sd: string, nowMs: number = Date.now()): AgentBar {
    const input = { ...readLoopStateInput(sd), nowMs };
    const view = computeLoopView(input);
    const ipc = getIpcState();
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const afk = afkState(input);
    const phase = view.phase;
    return {
        phase,
        presence: view.presence,
        afk: { mode: afk.mode, expires_at: iso(afk.expiryMs) },
        prompt: { visible: ipc.promptZoneVisible === true, has_input: ipc.promptHasInput === true },
        human_typing: humanIsTyping(sd),
        marker: {
            info: ipc.stateTagInfo ?? null,
            health_prompt: ipc.healthPromptVisible === true,
            resume_picker: ipc.resumeSessionPickerActive === true,
            resume_mode_picker: ipc.resumeModePickerActive === true,
        },
        alerts: {
            link_down: ipc.linkDown === true,
            daemon_down: ipc.daemonDown === true,
            not_logged_in: ipc.notLoggedIn === true,
            trust_dialog: ipc.trustDialog === true,
            api_unreachable: ipc.apiUnreachable === true,
            // #3074 — Claude Code installed an update: a host offers the restart.
            restart_needed: ipc.restartNeeded === true,
            // #3117 — a restart ordered `when_idle` is waiting for Claude to go idle.
            restart_pending: ipc.restartPending === true,
            // #3268
            limit_reached: ipc.limitReached === true,
        },
        proxy_alive: proxyIsAlive(sd),
        zen: existsSync(zenPath(sd)),
        counters: ipc.counters ?? null,
        // Only while idle, as the tmux countdown: busy, the next wake is not due.
        next_wake_at: phase === "idle" && ipc.nextWakeAtMs !== null && ipc.nextWakeAtMs > nowMs ? iso(ipc.nextWakeAtMs) : null,
        // #3268 — when the reached limit lifts, as said; null when none is reached.
        limit_resets: ipc.limitReached ? ipc.limitResets ?? null : null,
        // #3283 — the model Claude ran its last turn on, and its short name.
        model: ipc.model ? { id: ipc.model, name: modelShortName(ipc.model) } : null,
        // #3291 — whether Claude is in Remote Control, whatever turned it on.
        remote_control: { on: ipc.remoteControl === true },
        boot: phase === "boot"
            ? { started_at: new Date(input.loopStartMs).toISOString(), deadline_at: iso(ipc.bootDeadlineMs ?? null) }
            : null,
        host: readBarHost(sd),
        // #3066 — where a client attaches, from where this kernel runs.
        attach: attachFor({
            hostControl: process.env[CL_ENV.HOST_CONTROL] || null,
            remoteUrl: process.env.AIBALL_SOCK ? null : process.env.AIBALL_URL || null,
        }),
    };
}

/**
 * #3044 — what a change of bar host does to the tmux session: `external` turns
 * tmux's status line off; back to `tmux` turns it on and repaints it whole (the
 * renderer skipped every change meanwhile). The first reading only acts when it
 * is `external`: a loop drawing in tmux leaves the session's line as it is.
 */
export function barHostTransition(prev: BarHost | null, next: BarHost): { status: "on" | "off" | null; repaint: boolean } {
    if (prev === next) return { status: null, repaint: false };
    if (next === "external") return { status: "off", repaint: false };
    return prev === null ? { status: null, repaint: false } : { status: "on", repaint: true };
}

/** Diff deux snapshots et retourne la liste des champs qui ont
 *  changé. Liste vide = no-op (rien à repaint). */
export function diffSnapshots(prev: BarSnapshot | null, next: BarSnapshot): (keyof BarSnapshot)[] {
    if (prev === null) return ["humanWord", "loopStatus", "stateTag", "proxyAlive", "zenActive", "counters", "nextWakeInSec", "bootElapsedSec", "bootRemainingSec", "afkGlyph", "promptGlyph", "typingGlyph"];
    const changed: (keyof BarSnapshot)[] = [];
    if (prev.humanWord !== next.humanWord) changed.push("humanWord");
    if (prev.loopStatus !== next.loopStatus) changed.push("loopStatus");
    // #1039 — either link up/down flips the bar bg ; route through the
    // status-bg repaint (same block as loopStatus).
    if (prev.linkDown !== next.linkDown) changed.push("loopStatus");
    if (prev.daemonDown !== next.daemonDown) changed.push("loopStatus");
    // #1072 — not-logged-in flips the bar bg ORANGE + the state-tag hint ;
    // route through the same status-bg repaint block.
    if (prev.notLoggedIn !== next.notLoggedIn) changed.push("loopStatus");
    if (prev.limitReached !== next.limitReached || prev.limitResetsText !== next.limitResetsText) changed.push("loopStatus");
    // #2230 — the trust dialog flips the bar ORANGE + the state-tag hint too.
    if (prev.trustDialog !== next.trustDialog) changed.push("loopStatus");
    // #1116 — api-unreachable flips the bar bg ORANGE + the state-tag hint too.
    if (prev.apiUnreachable !== next.apiUnreachable) changed.push("loopStatus");
    if (prev.stateTag !== next.stateTag) changed.push("stateTag");
    if (prev.proxyAlive !== next.proxyAlive) changed.push("proxyAlive");
    if (prev.zenActive !== next.zenActive) changed.push("zenActive");
    if (!countersEqual(prev.counters, next.counters)) changed.push("counters");
    if (prev.nextWakeInSec !== next.nextWakeInSec) changed.push("counters");
    if (prev.bootElapsedSec !== next.bootElapsedSec) changed.push("counters");
    if (prev.bootRemainingSec !== next.bootRemainingSec) changed.push("counters");
    if (prev.afkGlyph !== next.afkGlyph) changed.push("afkGlyph");
    if (prev.promptGlyph !== next.promptGlyph) changed.push("promptGlyph");
    if (prev.typingGlyph !== next.typingGlyph) changed.push("typingGlyph");
    return changed;
}

function countersEqual(
    a: BarSnapshot["counters"],
    b: BarSnapshot["counters"],
): boolean {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    return a.open === b.open && a.backlog === b.backlog && a.events === b.events;
}

/** Spawn-tmux callable injection — vrai `spawnSync` en prod, mock dans
 *  les tests. */
export type SpawnFn = (cmd: string, args: string[], opts: { stdio: "ignore" }) => unknown;

/**
 * #3461 — the kernel's writer: each option goes to the multiplexer without
 * the kernel waiting, in the order asked (a later value is never overwritten
 * by an earlier write finishing last). A `spawnSync` per option held the
 * kernel ~100 ms each on Windows, every second while a countdown ran.
 */
export function queuedSpawn(): SpawnFn {
    const queue = muxQueue();
    return (_cmd, args) => { queue.push(args); };
}

/**
 * BarRenderer = pur observer de `ipcState` qui debounce + diff + paint
 * tmux. Slice 3 a flippé le writer-effectif ; les paints legacy
 * (`setTmuxStatus`/`setTmuxCounters`/`setTmuxAfkState`) sont neutralisés.
 */
export class BarRenderer {
    private sd: string;
    private name: string;
    private lastSnapshot: BarSnapshot | null = null;
    private debounceTimer: NodeJS.Timeout | null = null;
    private safetyTimer: NodeJS.Timeout | null = null;
    private unsubIpc: (() => void) | null = null;
    private spawn: SpawnFn;
    /** #3030 — where the bar as data goes (the daemon), or null for none. */
    private publish: ((bar: AgentBar) => void) | null;
    private computeBar: () => AgentBar;
    private lastPublishedJson: string | null = null;
    private lastPublishedAt = 0;
    private pendingBar: AgentBar | null = null;
    private publishTimer: NodeJS.Timeout | null = null;
    /** #3044 — the bar host last applied to the session; null before the first tick. */
    private lastHost: BarHost | null = null;
    /** At most one push per this window; the last change of a burst is sent
     *  when it closes, so the daemon always ends on the loop's true state. */
    static readonly PUBLISH_MIN_GAP_MS = 1000;
    /** Debounce window (ms) — aligné sur `schedulePush` du timer. */
    private static readonly DEBOUNCE_MS = 50;
    /** Safety tick — catch time-driven changes invisibles à onIpcChanged
     *  (TTL expiry de `humanTypingAtMs`, countdown wait_10m de l'AFK chip). */
    private static readonly SAFETY_TICK_MS = 1000;

    constructor(
        sd: string,
        name: string,
        spawn: SpawnFn = spawnSync as SpawnFn,
        publish: ((bar: AgentBar) => void) | null = null,
        computeBar: () => AgentBar = () => computeAgentBar(sd),
    ) {
        this.sd = sd;
        this.name = name;
        this.spawn = spawn;
        this.publish = publish;
        this.computeBar = computeBar;
    }

    /** Démarre l'observer : initial paint + subscribe à onIpcChanged
     *  + safety tick 1s. */
    start(): void {
        this.tick();
        this.unsubIpc = onIpcChanged(() => this.schedule());
        this.safetyTimer = setInterval(() => this.tick(), BarRenderer.SAFETY_TICK_MS);
    }

    /** Arrête l'observer : unsubscribe + flush le debounce/safety pending. */
    stop(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.safetyTimer) {
            clearInterval(this.safetyTimer);
            this.safetyTimer = null;
        }
        if (this.unsubIpc) {
            this.unsubIpc();
            this.unsubIpc = null;
        }
        if (this.publishTimer) {
            clearTimeout(this.publishTimer);
            this.publishTimer = null;
        }
    }

    /**
     * #3030 — push the bar as data when it changed: at once if the last push is
     * older than `PUBLISH_MIN_GAP_MS`, else once that window closes (the latest
     * value then, not the one that opened it). Exposed for tests.
     */
    publishBar(nowMs: number = Date.now()): void {
        if (!this.publish) return;
        let bar: AgentBar;
        try {
            bar = this.computeBar();
        } catch {
            return;
        }
        const json = JSON.stringify(bar);
        if (json === this.lastPublishedJson && this.pendingBar === null) return;
        const wait = this.lastPublishedAt + BarRenderer.PUBLISH_MIN_GAP_MS - nowMs;
        if (wait <= 0 && this.publishTimer === null) {
            this.send(bar, json, nowMs);
            return;
        }
        this.pendingBar = bar;
        if (this.publishTimer) return;
        this.publishTimer = setTimeout(() => {
            this.publishTimer = null;
            const next = this.pendingBar;
            this.pendingBar = null;
            if (!next) return;
            const nextJson = JSON.stringify(next);
            if (nextJson !== this.lastPublishedJson) this.send(next, nextJson, Date.now());
        }, Math.max(0, wait));
        this.publishTimer.unref?.();
    }

    private send(bar: AgentBar, json: string, nowMs: number): void {
        this.lastPublishedJson = json;
        this.lastPublishedAt = nowMs;
        try {
            this.publish!(bar);
        } catch {
            // A failed push is retried on the next change; the tmux bar is unaffected.
        }
    }

    /** Schedule un tick debouncé. Idempotent : un burst de mutations
     *  ipcState coalesce en UN seul tick. */
    private schedule(): void {
        if (this.debounceTimer) return;
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.tick();
        }, BarRenderer.DEBOUNCE_MS);
    }

    /** Compute le snapshot, diff, paint les changes. Exposé pour test. */
    tick(): void {
        this.publishBar();
        try {
            // #3044 — another host draws the bar: the data is still published
            // (above), tmux's line is off, and nothing is painted into it.
            const host = readBarHost(this.sd);
            if (host !== this.lastHost) this.applyHost(host);
            if (host === "external") return;
            const next = computeBarSnapshot(this.sd);
            const changed = diffSnapshots(this.lastSnapshot, next);
            if (changed.length === 0) return;
            for (const field of changed) {
                const val = next[field];
                const str = typeof val === "object" && val !== null
                    ? JSON.stringify(val)
                    : String(val);
                logBarPaint(this.sd, `barrender:${field}`, str);
            }
            this.paint(next, changed);
            this.lastSnapshot = next;
        } catch {
            // Swallow — next tick retries. Le bus ne doit pas crash.
        }
    }

    /** #3044 — apply a new bar host to the session (see `barHostTransition`). */
    private applyHost(host: BarHost): void {
        const t = barHostTransition(this.lastHost, host);
        this.lastHost = host;
        if (t.status) this.spawn(MUX_CMD, ["set-option", "-t", tmuxName(this.name), "status", t.status], { stdio: "ignore" });
        if (t.repaint) this.lastSnapshot = null;
        logBarPaint(this.sd, "barrender:host", host);
    }

    /** Peint les options tmux qui ont changé. Pure (depends seulement
     *  du snapshot + this.spawn) → testable. */
    private paint(next: BarSnapshot, changed: (keyof BarSnapshot)[]): void {
        const tn = tmuxName(this.name);
        const setOpt = (opt: string, val: string): void => {
            // An EMPTY value is how this renderer turns a glyph off — and on
            // Windows `psmux set-option <opt> ""` silently keeps the previous
            // value. It exits 0, writes nothing to stderr, and the option is
            // unchanged. Measured:
            //
            //     set @probe "XXX"  → get "XXX"
            //     set @probe ""     → get "XXX"   ← still there, status 0
            //
            // So no glyph could ever go out on win32: the typing `⌨` lit on the
            // first keystroke and stayed for the session, and `@cl_human` with
            // it. The repaint logic was running the whole time and computing the
            // right empty string — the write was being swallowed.
            //
            // `-u` (unset) is the operation that actually means "no value", and
            // an unset user option renders as empty in the status format, which
            // is exactly what the caller wants. Tmux accepts the empty argument,
            // so Unix behaviour is unchanged either way; routing both platforms
            // through `-u` keeps one path rather than a win32 special case.
            if (val === "") {
                this.spawn(MUX_CMD, ["set-option", "-t", tn, "-u", opt], { stdio: "ignore" });
                return;
            }
            this.spawn(MUX_CMD, ["set-option", "-t", tn, opt, val], { stdio: "ignore" });
        };
        const changedSet = new Set(changed);
        // #3469 — the values come from `barOptionValues`, shared with the
        // session host's `claude-loop attach`; only the changed groups go out.
        const v = barOptionValues(next, barColors());
        if (changedSet.has("loopStatus") || changedSet.has("stateTag")) {
            setOpt("status-bg", v["status-bg"]);
            setOpt("status-fg", v["status-fg"]);
            setOpt("@cl_state", v["@cl_state"]);
            setOpt("status-left", v["status-left"]);
        }
        if (changedSet.has("zenActive")) setOpt("@cl_zen", v["@cl_zen"]);
        if (changedSet.has("proxyAlive")) setOpt("@cl_proxy", v["@cl_proxy"]);
        // #862 Slice 4 — the BarRenderer is the ONLY writer of `@cl_human`.
        if (changedSet.has("humanWord")) setOpt("@cl_human", v["@cl_human"]);
        if (changedSet.has("counters")) setOpt("@cl_counts", v["@cl_counts"]);
        if (changedSet.has("promptGlyph")) setOpt("@cl_prompt", v["@cl_prompt"]);
        if (changedSet.has("typingGlyph")) setOpt("@cl_typing", v["@cl_typing"]);
        if (changedSet.has("afkGlyph")) setOpt("@cl_afk_glyph", v["@cl_afk_glyph"]);
    }
}

/** The bar's colours, as the project config sets them. */
export type BarColors = ReturnType<typeof barColors>;

/** #3469 — the tmux options the bar is made of, by name. */
export interface BarOptions {
    "status-bg": string;
    "status-fg": string;
    "@cl_state": string;
    "status-left": string;
    "@cl_zen": string;
    "@cl_proxy": string;
    "@cl_human": string;
    "@cl_counts": string;
    "@cl_prompt": string;
    "@cl_typing": string;
    "@cl_afk_glyph": string;
}

/**
 * #3469 — every option of the bar for one snapshot, pure: what `paint` writes
 * into tmux, and what `claude-loop attach` draws itself on the session host,
 * so both bars are the same one.
 */
export function barOptionValues(next: BarSnapshot, col: BarColors): BarOptions {
    // #1039 — a lost link (proxy↔timer OR loop↔daemon) paints the bar
    // RED (overrides per-state bg) so the broken state is visible.
    // #1072 — not-logged-in paints ORANGE (colour208, same as ZEN) and
    // takes PRIORITY over the RED overlay : it's the state the human can
    // fix immediately (run /login).
    // #1116 — api-unreachable shares the ORANGE overlay + priority with
    // not-logged-in : both are "no point waking, here's why" states.
    const bg = (next.trustDialog || next.notLoggedIn || next.limitReached || next.apiUnreachable)
        ? "colour208"
        : (next.linkDown || next.daemonDown) ? col.link_down_bg : stateBg(col, next.loopStatus);
    // #950 — @cl_state lives in the black (colour16) block next to `claude`,
    // tokens space-separated (cf. renderMarkerSegment).
    // #1072 — surface WHY the bar is orange so the human knows to /login.
    const stateTagStr = next.trustDialog
        ? "⚠ trust this folder? · attach to answer"
        : next.notLoggedIn
        ? "⚠ not logged in · /login"
        : next.limitReached
        ? `⚠ usage limit reached · held${next.limitResetsText ? ` · resets ${next.limitResetsText}` : ""}`
        // #3362 — no update or restart hint here: an update Claude Code
        // installed is the agent bar's news (`alerts.restart_needed`), for
        // a host to offer the restart; the tmux bar leaves it out.
        : next.apiUnreachable ? "⚠ API unreachable · retrying"
        : next.stateTag;
    const c = next.counters;
    // #911 — counters ALWAYS shown; `-` before the first read.
    const parts = [`o:${c?.open ?? "-"}`, `b:${c?.backlog ?? "-"}`, `e:${c?.events ?? "-"}`];
    // #891 — 🚀Ns +Ns during boot; after it, 📨 standing while work waits,
    // with the next wake's countdown when one is armed (#1041).
    if (next.bootElapsedSec !== null) {
        parts.push(`🚀${next.bootElapsedSec}s`);
        if (next.bootRemainingSec !== null) parts.push(`+${next.bootRemainingSec}s`);
    } else {
        const hasPending = (c?.events ?? 0) > 0 || (c?.backlog ?? 0) > 0;
        if (hasPending || next.nextWakeInSec !== null) {
            parts.push(next.nextWakeInSec !== null ? `📨 ${next.nextWakeInSec}s` : "📨");
        }
    }
    return {
        "status-bg": bg,
        "status-fg": col.bar_fg,
        "@cl_state": `#[fg=${col.island_fg},bg=colour16] ${stateTagStr}`,
        // @cl_state right after `claude`, before the fade-out glyph; the
        // counters stay on the coloured status-bg to the right.
        "status-left": `${COPY_MARK}#[bg=${bg}] #[fg=${bg},bg=colour16]▓▒░#{@cl_afk_glyph}#[fg=${col.island_fg}]#{@cl_prompt}#{@cl_typing}#{@cl_human}#[fg=${col.island_fg}] claude#{@cl_state} #[fg=${bg},bg=colour16]░▒▓#[bg=${bg}]#{@cl_proxy}#[fg=${col.bar_fg}]#{@cl_counts} `,
        "@cl_zen": next.zenActive ? `#[fg=colour16,bg=colour208,bold] ZEN #[default] ` : "",
        "@cl_proxy": next.proxyAlive ? `#[fg=colour250] ⇄` : "",
        "@cl_human": next.humanWord,
        "@cl_counts": `#[fg=${col.bar_fg}] ${parts.join(" ")}`,
        // `❯` BEFORE `claude`; a leading space when shown keeps the block compact.
        "@cl_prompt": next.promptGlyph ? ` ${next.promptGlyph}` : "",
        // `⌨` on its own, shown IF typing, without overwriting wait/loop.
        "@cl_typing": next.typingGlyph ? ` ${next.typingGlyph}` : "",
        // #962 — already prefixed with its colour tags and leading space.
        "@cl_afk_glyph": next.afkGlyph,
    };
}

/**
 * #3469 — the bar's right side: the zen chip, the loop's name, how to detach,
 * and the AFK key (`AFK:OFF` when the loop has none). Static for a session:
 * `claude-loop start` writes it into tmux once, `claude-loop attach` draws it.
 */
export function statusRightFormat(col: Pick<BarColors, "afk_label_fg" | "bar_fg">, afkKeyDisp: string | null, detachDisp: string): string {
    const afkStatic = afkKeyDisp !== null
        ? `#[fg=${col.afk_label_fg}]AFK:#[fg=${col.bar_fg}]${afkKeyDisp}`
        : `#[fg=${col.afk_label_fg}]AFK:OFF`;
    return `#{@cl_zen}#[fg=${col.bar_fg}]#{@cl_name} #[fg=${col.afk_label_fg}]· DETACH:#[fg=${col.bar_fg}]${detachDisp} #[fg=${col.afk_label_fg}]· ${afkStatic} `;
}
