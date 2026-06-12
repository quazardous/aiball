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
import { WAKE_COOLDOWN_MS } from "./wake-machine.js";

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
     *  pas idle / busy / unknown / pas d'event à drainer. Rendu après les
     *  counters comme `📨Ns`. */
    nextWakeInSec: number | null;
    /** #850 — session health score 1-5 captured by HealthCheckWatcher.
     *  `null` = not captured (prompt pending or never injected).
     *  Rendered in the counters zone as `H:N` colored red (1-2),
     *  yellow (3), green (4-5). */
    sessionHealthScore: number | null;
    /** #891 — boot elapsed et remaining (seconds). `null` hors boot.
     *  Rendus dans la zone compteurs comme `🚀Ns +Ns`, prioritaires
     *  sur nextWakeInSec. */
    bootElapsedSec: number | null;
    bootRemainingSec: number | null;
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
function renderStateTag(loopStatus: LoopStatus, info: string | null): string {
    // #891 david : drop le Ns elapsed + +Ns remaining du state tag.
    // Tout dans la zone compteurs maintenant (cf. counters paint).
    return info ? `[${loopStatus}:${info}]` : `[${loopStatus}]`;
}

// #919 — module-level state pour détecter les transitions du gate
// countdown (= flicker). Log seulement sur transition pour éviter le spam.
let _lastCountdownNull: boolean | null = null;
let _lastCountdownReason = "";
function logCountdownTransition(nowNull: boolean, reason: string): void {
    if (_lastCountdownNull === nowNull && _lastCountdownReason === reason) return;
    _lastCountdownNull = nowNull;
    _lastCountdownReason = reason;
    // eslint-disable-next-line no-console
    console.log(`[bar-countdown] ${nowNull ? "OFF" : "ON"} reason=${reason}`);
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
    const stateTag = renderStateTag(loopStatus, ipc.stateTagInfo);
    const zenActive = existsSync(zenPath(sd));
    const counters = ipc.counters;
    const afkChipStr = afkStateChunkStr(sd);
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
    // #805 / #919 — countdown = grace d'entrée de la FIFO drain.
    //
    // David `<chat>` : « si ça fait plus de 10s qu'on est en idle
    // normalement le pipe est ouvert (c'est une fifo pas une tempo) ».
    // Le 10s `WAKE_COOLDOWN_MS` est la fenêtre de GRACE après bascule en
    // idle, pas un throttle cyclique. Sémantique :
    //
    //   [idle entry] ────── grace 10s (countdown 10→1) ───── [pipe OPEN]
    //                                                          │
    //                                                          ▼
    //                                              drain instant sur SSE
    //                                              ou idle:settled tick
    //
    // Donc countdown affiché UNIQUEMENT pendant la grace
    // `[idleSinceMs, idleSinceMs+WAKE_COOLDOWN_MS]`. Past 10s : null (=
    // pipe ouvert, prêt à drainer, pas de countdown utile).
    //
    // Gate : `view.phase === "idle"` (bar shows [idle]) + `idleSinceMs`
    // set. Pas de gate IdleMachine XState ni loopStart : tous deux
    // proved unreliable across reloads / SessionStart-loss (cf.
    // historique tickets `86fjp3` rejet + `67946f9` toujours pas
    // affiché `gjx8ek`).
    let nextWakeInSec: number | null = null;
    const idleSinceMs = ipc.idleSinceMs;
    if (view.phase === "idle" && idleSinceMs !== null) {
        const remainingMs = (idleSinceMs + WAKE_COOLDOWN_MS) - input.nowMs;
        if (remainingMs > 0) {
            nextWakeInSec = Math.ceil(remainingMs / 1000);
        }
        // Past grace : nextWakeInSec stays null = pipe ouvert, drain
        // instant sur prochain SSE / idle:settled, pas de countdown.
    }
    logCountdownTransition(
        nextWakeInSec === null,
        view.phase !== "idle" ? `view.phase=${view.phase}`
            : idleSinceMs === null ? "idleSinceMs=null"
                : "pipe-open (past grace)",
    );
    return {
        humanWord,
        loopStatus,
        stateTag,
        proxyAlive,
        zenActive,
        counters,
        nextWakeInSec,
        sessionHealthScore: ipc.sessionHealthScore,
        bootElapsedSec,
        bootRemainingSec,
        afkChipStr,
    };
}

/** Diff deux snapshots et retourne la liste des champs qui ont
 *  changé. Liste vide = no-op (rien à repaint). */
export function diffSnapshots(prev: BarSnapshot | null, next: BarSnapshot): (keyof BarSnapshot)[] {
    if (prev === null) return ["humanWord", "loopStatus", "stateTag", "proxyAlive", "zenActive", "counters", "nextWakeInSec", "sessionHealthScore", "bootElapsedSec", "bootRemainingSec", "afkChipStr"];
    const changed: (keyof BarSnapshot)[] = [];
    if (prev.humanWord !== next.humanWord) changed.push("humanWord");
    if (prev.loopStatus !== next.loopStatus) changed.push("loopStatus");
    if (prev.stateTag !== next.stateTag) changed.push("stateTag");
    if (prev.proxyAlive !== next.proxyAlive) changed.push("proxyAlive");
    if (prev.zenActive !== next.zenActive) changed.push("zenActive");
    if (!countersEqual(prev.counters, next.counters)) changed.push("counters");
    if (prev.nextWakeInSec !== next.nextWakeInSec) changed.push("counters");
    if (prev.sessionHealthScore !== next.sessionHealthScore) changed.push("counters");
    if (prev.bootElapsedSec !== next.bootElapsedSec) changed.push("counters");
    if (prev.bootRemainingSec !== next.bootRemainingSec) changed.push("counters");
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
            // #911 david `hsd3vw` : counters TOUJOURS affichés. Si le
            // fetch a échoué (counters null) OU est en cold-boot avant
            // le 1er succès, fallback `o:- b:- e:-` pour que l'opérateur
            // sache que la zone existe mais que les données ne sont
            // pas encore là.
            parts.push(`o:${c?.open ?? "-"}`);
            parts.push(`b:${c?.backlog ?? "-"}`);
            parts.push(`e:${c?.events ?? "-"}`);
            // #891 — countdowns harmonisés dans la zone compteurs :
            //   - 🚀Ns +Ns pendant boot (prioritaire, mutually exclusive)
            //   - 📨Ns post-boot quand events/backlog pending (#805 xxvzye)
            if (next.bootElapsedSec !== null) {
                parts.push(`🚀${next.bootElapsedSec}s`);
                if (next.bootRemainingSec !== null) parts.push(`+${next.bootRemainingSec}s`);
            } else if (next.nextWakeInSec !== null) {
                parts.push(`📨${next.nextWakeInSec}s`);
            }
            // #850 — claude's session self-rating, colored by tier :
            // red 1-2 (struggling), yellow 3 (mid), green 4-5 (cruising).
            // Appended after the boot/wake countdowns so it lives at the
            // tail of the counters segment.
            const col = barColors();
            if (next.sessionHealthScore !== null) {
                const score = next.sessionHealthScore;
                const fg = score <= 2 ? "colour196" /* red */
                    : score === 3 ? "colour178" /* yellow */
                        : "colour46" /* green */;
                parts.push(`#[fg=${fg}]H:${score}#[fg=${col.bar_fg}]`);
            }
            setOpt("@cl_counts", `#[fg=${col.bar_fg}] ${parts.join(" ")}`);
        }
        if (changedSet.has("afkChipStr")) {
            setOpt("@cl_afk_state", next.afkChipStr);
            this.spawn(MUX_CMD, ["refresh-client", "-S"], { stdio: "ignore" });
        }
    }
}
