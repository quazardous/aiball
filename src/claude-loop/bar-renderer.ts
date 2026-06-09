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
import { onIpcChanged } from "./ipc-state.js";
import {
    MUX_CMD,
    humanBarWord,
    logBarPaint,
    proxyIsAlive,
    readLoopStateInput,
    tmuxName,
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
}

/** Compute le snapshot canonique depuis ipcState + computeLoopView.
 *  Pure : pas de side-effect, pas de spawn tmux. */
export function computeBarSnapshot(sd: string): BarSnapshot {
    const input = readLoopStateInput(sd);
    const view = computeLoopView(input);
    const proxyAlive = proxyIsAlive(sd);
    const humanWord = humanBarWord(sd);
    // Map view.phase → LoopStatus (= bar bg color + tag).
    const loopStatus: LoopStatus = view.phase === "boot"
        ? LOOP_STATUS.BOOT
        : view.phase === "busy"
            ? LOOP_STATUS.BUSY
            : LOOP_STATUS.IDLE;
    // Le state tag est `[<status>]` + suffix info. Pour Slice 1 on
    // garde la version basique ; Slice 3 ajoutera le suffix `:info`.
    const stateTag = `[${loopStatus}]`;
    return { humanWord, loopStatus, stateTag, proxyAlive };
}

/** Diff deux snapshots et retourne la liste des champs qui ont
 *  changé. Liste vide = no-op (rien à repaint). */
export function diffSnapshots(prev: BarSnapshot | null, next: BarSnapshot): (keyof BarSnapshot)[] {
    if (prev === null) return ["humanWord", "loopStatus", "stateTag", "proxyAlive"];
    const changed: (keyof BarSnapshot)[] = [];
    if (prev.humanWord !== next.humanWord) changed.push("humanWord");
    if (prev.loopStatus !== next.loopStatus) changed.push("loopStatus");
    if (prev.stateTag !== next.stateTag) changed.push("stateTag");
    if (prev.proxyAlive !== next.proxyAlive) changed.push("proxyAlive");
    return changed;
}

/**
 * BarRenderer = pur observer de `ipcState` qui debounce + diff + log.
 * **Slice 1 ne paint PAS encore tmux** ; le flip writer-effectif arrive
 * en Slice 3.
 */
export class BarRenderer {
    private sd: string;
    private name: string;
    private lastSnapshot: BarSnapshot | null = null;
    private debounceTimer: NodeJS.Timeout | null = null;
    private unsubIpc: (() => void) | null = null;
    /** Debounce window (ms) — aligné sur `schedulePush` du timer. */
    private static readonly DEBOUNCE_MS = 50;

    constructor(sd: string, name: string) {
        this.sd = sd;
        this.name = name;
    }

    /** Démarre l'observer : initial paint + subscribe à onIpcChanged. */
    start(): void {
        // Initial paint = compute + log tout au moins une fois.
        this.tick();
        this.unsubIpc = onIpcChanged(() => this.schedule());
    }

    /** Arrête l'observer : unsubscribe + flush le debounce pending. */
    stop(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
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

    /** Compute le snapshot, diff, log les changes (Slice 1 = pas de
     *  spawnSync tmux). Exposé pour test. */
    tick(): void {
        try {
            const next = computeBarSnapshot(this.sd);
            const changed = diffSnapshots(this.lastSnapshot, next);
            if (changed.length === 0) return; // no-op
            for (const field of changed) {
                logBarPaint(
                    this.sd,
                    `observer:${field}`,
                    String(next[field]),
                );
            }
            this.lastSnapshot = next;
            // Slice 3+ : flusher ici un set-option batched. Pour l'instant
            // on s'autocensure pour que le legacy painter reste autoritaire.
            void _flushUnusedSlice1(this.name);
        } catch {
            // Swallow — next tick retries. Sweep ne doit pas casser le bus.
        }
    }
}

/** Slice 1 placeholder : on ne paint pas encore. La fonction existe
 *  pour bloquer le typecheck sur un MUX_CMD inutilisé et préparer le
 *  scaffold de la slice 3 (où on va batched-set-option ici). */
function _flushUnusedSlice1(_name: string): void {
    // intentionnellement vide en Slice 1
    void MUX_CMD;
    void spawnSync;
    void tmuxName;
}
