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
    afkGlyphChunk,
    barColors,
    humanPresenceChunk,
    typingGlyphChunk,
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

function renderMarkerSegment(
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
    const promptGlyph = ipc.promptZoneVisible ? "❯" : "";
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
    };
}

/** Diff deux snapshots et retourne la liste des champs qui ont
 *  changé. Liste vide = no-op (rien à repaint). */
export function diffSnapshots(prev: BarSnapshot | null, next: BarSnapshot): (keyof BarSnapshot)[] {
    if (prev === null) return ["humanWord", "loopStatus", "stateTag", "proxyAlive", "zenActive", "counters", "nextWakeInSec", "bootElapsedSec", "bootRemainingSec", "afkGlyph", "promptGlyph", "typingGlyph"];
    const changed: (keyof BarSnapshot)[] = [];
    if (prev.humanWord !== next.humanWord) changed.push("humanWord");
    if (prev.loopStatus !== next.loopStatus) changed.push("loopStatus");
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
            // #950 david `<chat>` : @cl_state vit maintenant DANS le bloc
            // fond noir (colour16) à côté de `claude-loop` — meilleur
            // contraste. Plus de crochets / colons, tokens space-separated
            // (cf. renderMarkerSegment).
            setOpt("@cl_state", `#[fg=${col.island_fg},bg=colour16] ${next.stateTag}`);
            // status-left : @cl_state collé à `claude-loop`, AVANT la
            // fade-out glyph. Les counters restent sur le status-bg
            // coloré à droite.
            setOpt(
                "status-left",
                `#[bg=${bg}] #[fg=${bg},bg=colour16]▓▒░#{@cl_afk_glyph}#[fg=${col.island_fg}]#{@cl_prompt}#{@cl_typing}#{@cl_human}#[fg=${col.island_fg}] claude#{@cl_state} #[fg=${bg},bg=colour16]░▒▓#[bg=${bg}]#{@cl_proxy}#[fg=${col.bar_fg}]#{@cl_counts} `,
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
            const col = barColors();
            setOpt("@cl_counts", `#[fg=${col.bar_fg}] ${parts.join(" ")}`);
        }
        if (changedSet.has("promptGlyph")) {
            // david `<chat>` 2026-06-14 : `❯` AVANT le mot `claude` ;
            // un espace est inclus dans la valeur quand non-vide pour
            // garder le bloc compact quand la prompt-zone disparaît.
            const v = next.promptGlyph ? ` ${next.promptGlyph}` : "";
            setOpt("@cl_prompt", v);
        }
        if (changedSet.has("typingGlyph")) {
            // david `<chat>` 2026-06-14 : `⌨` indépendant — affiché
            // SI typing, sans écraser le wait/loop dans @cl_human.
            // Positioned entre @cl_prompt et @cl_human. La valeur
            // est déjà préfixée des color tags par `typingGlyphChunk`.
            const v = next.typingGlyph ? ` ${next.typingGlyph}` : "";
            setOpt("@cl_typing", v);
        }
        if (changedSet.has("afkGlyph")) {
            // #962 — bonhomme glyph + color/suffix selon le mode AFK.
            // Valeur déjà préfixée des color tags + leading space par
            // `afkGlyphChunk` ; vide en boot grace.
            setOpt("@cl_afk_glyph", next.afkGlyph);
        }
    }
}
