/**
 * #862 (`s8u6pt`) Slice 1 — observer-only BarRenderer.
 *
 * Le BarRenderer est un PUR OBSERVER de `ipcState`. Il souscrit à
 * `onIpcChanged`, debounce 50ms (= même cadence que `schedulePush`
 * existant), puis compute la "bar desired state" canonique à partir
 * de `getIpcState()` + `computeLoopView` + diff vs le dernier snapshot
 * peint en interne. Si rien n'a changé → no-op.
 *
 * **API publique = ZÉRO méthode externe** : `start()` / `stop()`. Les
 * autres modules NE SAVENT PAS qu'il existe ; ils mutent uniquement
 * `setIpc*`, et la barre se met à jour automatiquement.
 *
 * **Slice 1** : OBSERVE + LOG seulement. Pas d'écriture tmux. Le but
 * = valider que le snapshot computed match les paints actuels, en
 * faisant tourner les deux en parallèle. Les divergences atterrissent
 * dans `bar-paint.log` avec writer=`observer:<field>` pour comparaison.
 *
 * Slice 3 fera le flip writer-effectif (= la classe écrit, les paints
 * legacy deviennent no-op). Slice 4 retire `_paint_word` côté proxy.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getIpcState, onIpcChanged } from "./ipc-state.js";
import {
    MUX_CMD,
    afkStateChunkStr,
    barColors,
    humanBarWord,
    logBarPaint,
    proxyIsAlive,
    readLoopStateInput,
    stateBg,
    tmuxName,
    zenPath,
    LOOP_STATUS,
    type LoopStatus,
} from "./state.js";
import { computeLoopView } from "./loop-state.js";

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
    /** #805 — countdown vers le prochain `idle:settled` wake. `null` =
     *  pas idle / busy / unknown. Rendu après les counters comme `⏳Ns`. */
    nextWakeInSec: number | null;
    /** `@cl_afk_state` : AFK chip pré-rendered string (canonical via
     *  `afkStateChunkStr`). Diff sur la string finale = plus simple que
     *  diff sur chaque field interne de l'AfkChunk. */
    afkChipStr: string;
}

/** State tag pipeline : compose `[<status>(:<info>)?] (<elapsed>s)? (+<remaining>s)?`
 *  as a `parts[].join(" ")`. Each fragment is contributed independently :
 *
 *  - **head**  : `[<status>]` ou `[<status>:<info>]` quand `stateTagInfo`
 *    est posé (par `setIpcStateTagInfo`, ex. "wait"/"compacting"/...).
 *  - **elapsed** (BOOT only) : `<elapsedSec>s` depuis `loopStartMs`,
 *    pour visualiser le temps déjà écoulé en phase boot.
 *  - **remaining** (BOOT only, deadline > now) : `+<remainingSec>s`
 *    delta-style — la deadline est watcher-driven (push `now+10s` chaque
 *    tick observant une condition "still booting"), donc le `+N` reflète
 *    l'extension dynamique plutôt qu'un countdown absolu.
 */
function renderStateTag(
    loopStatus: LoopStatus,
    info: string | null,
    input: { nowMs: number; loopStartMs: number },
    bootDeadlineMs: number | null,
): string {
    const parts: string[] = [];
    parts.push(info ? `[${loopStatus}:${info}]` : `[${loopStatus}]`);
    if (loopStatus !== LOOP_STATUS.BOOT) return parts.join(" ");
    const elapsedSec = Math.max(0, Math.floor((input.nowMs - input.loopStartMs) / 1000));
    parts.push(`${elapsedSec}s`);
    if (bootDeadlineMs !== null) {
        const remainingMs = bootDeadlineMs - input.nowMs;
        if (remainingMs > 0) {
            const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
            parts.push(`+${remainingSec}s`);
        }
    }
    return parts.join(" ");
}

/** Compute le snapshot canonique depuis ipcState + computeLoopView.
 *  Pure : pas de side-effect, pas de spawn tmux. */
export function computeBarSnapshot(sd: string): BarSnapshot {
    const input = readLoopStateInput(sd);
    const view = computeLoopView(input);
    const proxyAlive = proxyIsAlive(sd);
    const humanWord = humanBarWord(sd);
    const loopStatus: LoopStatus = view.phase === "boot"
        ? LOOP_STATUS.BOOT
        : view.phase === "busy"
            ? LOOP_STATUS.BUSY
            : LOOP_STATUS.IDLE;
    const ipc = getIpcState();
    const stateTag = renderStateTag(loopStatus, ipc.stateTagInfo, input, ipc.bootDeadlineMs);
    const zenActive = existsSync(zenPath(sd));
    const counters = ipc.counters;
    const afkChipStr = afkStateChunkStr(sd);
    // #805 — derive countdown sec from ipc.nextWakeAtMs. Negative or null
    // → segment off. Math.ceil pour que 0.4s reste 1s visible (= countdown
    // tick down to 0).
    let nextWakeInSec: number | null = null;
    if (ipc.nextWakeAtMs !== null) {
        const remainingMs = ipc.nextWakeAtMs - input.nowMs;
        if (remainingMs > 0) nextWakeInSec = Math.ceil(remainingMs / 1000);
    }
    return { humanWord, loopStatus, stateTag, proxyAlive, zenActive, counters, nextWakeInSec, afkChipStr };
}

/** Diff deux snapshots et retourne la liste des champs qui ont
 *  changé. Liste vide = no-op (rien à repaint). */
export function diffSnapshots(prev: BarSnapshot | null, next: BarSnapshot): (keyof BarSnapshot)[] {
    if (prev === null) return ["humanWord", "loopStatus", "stateTag", "proxyAlive", "zenActive", "counters", "nextWakeInSec", "afkChipStr"];
    const changed: (keyof BarSnapshot)[] = [];
    if (prev.humanWord !== next.humanWord) changed.push("humanWord");
    if (prev.loopStatus !== next.loopStatus) changed.push("loopStatus");
    if (prev.stateTag !== next.stateTag) changed.push("stateTag");
    if (prev.proxyAlive !== next.proxyAlive) changed.push("proxyAlive");
    if (prev.zenActive !== next.zenActive) changed.push("zenActive");
    if (!countersEqual(prev.counters, next.counters)) changed.push("counters");
    if (prev.nextWakeInSec !== next.nextWakeInSec) changed.push("counters");
    if (prev.afkChipStr !== next.afkChipStr) changed.push("afkChipStr");
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
    /** Debounce window (ms) — aligné sur `schedulePush` du timer. */
    private static readonly DEBOUNCE_MS = 50;
    /** Safety tick — catch time-driven changes invisibles à onIpcChanged
     *  (TTL expiry de `humanTypingAtMs`, countdown wait_10m de l'AFK chip). */
    private static readonly SAFETY_TICK_MS = 1000;

    constructor(sd: string, name: string, spawn: SpawnFn = spawnSync as SpawnFn) {
        this.sd = sd;
        this.name = name;
        this.spawn = spawn;
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
        try {
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

    /** Peint les options tmux qui ont changé. Pure (depends seulement
     *  du snapshot + this.spawn) → testable. */
    private paint(next: BarSnapshot, changed: (keyof BarSnapshot)[]): void {
        const tn = tmuxName(this.name);
        const setOpt = (opt: string, val: string): void => {
            this.spawn(MUX_CMD, ["set-option", "-t", tn, opt, val], { stdio: "ignore" });
        };
        const changedSet = new Set(changed);
        // loopStatus change → status-bg + status-left template (le bg
        // est inline dans la format string) + status-fg + @cl_state.
        if (changedSet.has("loopStatus") || changedSet.has("stateTag")) {
            const col = barColors();
            const bg = stateBg(col, next.loopStatus);
            setOpt("status-bg", bg);
            setOpt("status-fg", col.bar_fg);
            setOpt("@cl_state", `#[fg=${col.bar_fg}]${next.stateTag}`);
            // status-left embarque bg + name. Repaint quand le bg change.
            setOpt(
                "status-left",
                `#[bg=${bg}] #[fg=${bg},bg=colour16]▓▒░#[fg=${col.island_fg}] claude-#{?@cl_human,#{@cl_human},#[fg=colour178#,bg=colour16]boot} #[fg=${bg},bg=colour16]░▒▓#[bg=${bg}]#{@cl_proxy}#[fg=${col.bar_fg}] ${this.name} #{@cl_state}#{@cl_counts} `,
            );
        }
        if (changedSet.has("zenActive")) {
            setOpt(
                "@cl_zen",
                next.zenActive
                    ? `#[fg=colour16,bg=colour208,bold] ZEN #[default] `
                    : "",
            );
        }
        if (changedSet.has("proxyAlive")) {
            setOpt("@cl_proxy", next.proxyAlive ? `#[fg=colour250] ⇄` : "");
        }
        // #862 Slice 4 — `_paint_word` côté proxy supprimé. Le BarRenderer
        // est maintenant le SEUL writer de `@cl_human` (proxy alive ou mort).
        if (changedSet.has("humanWord")) {
            setOpt("@cl_human", next.humanWord);
        }
        if (changedSet.has("counters")) {
            const c = next.counters;
            const parts: string[] = [];
            if (c !== null) {
                if (c.open !== null) parts.push(`o:${c.open}`);
                if (c.backlog !== null) parts.push(`b:${c.backlog}`);
                if (c.events !== null) parts.push(`e:${c.events}`);
            }
            // #805 — countdown vers prochain wake. Symbole `⏳` (hourglass)
            // pour distinguer du `+Ns` boot remaining (qui suit le state tag).
            if (next.nextWakeInSec !== null) parts.push(`⏳${next.nextWakeInSec}s`);
            if (parts.length === 0) {
                setOpt("@cl_counts", "");
            } else {
                const col = barColors();
                setOpt("@cl_counts", `#[fg=${col.bar_fg}] ${parts.join(" ")}`);
            }
        }
        if (changedSet.has("afkChipStr")) {
            setOpt("@cl_afk_state", next.afkChipStr);
            this.spawn(MUX_CMD, ["refresh-client", "-S"], { stdio: "ignore" });
        }
    }
}
