/**
 * #505 phase 2 — partagé entre `src/api/agents.ts` (chemin local, agent qui
 * tourne sur le même host que le daemon) et la WS reverse côté node
 * (`src/proxy.ts`, agent qui tourne sur un node distant). Le contenu vient de
 * `agents.ts` d'origine (#464/#472) — extrait tel quel pour pouvoir l'appeler
 * depuis le handler WS sans embarquer Express.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { MUX_CMD, tmuxName } from "./claude-loop/state.js";

/** Soft cap sur une capture de pane — quelques KB en pratique, on borne pour
 *  ne pas spammer le canal sortant. */
export const MAX_PAYLOAD_BYTES = 64_000;

/** Max longueur d'un payload `send-keys` (typique : < 100 bytes, on cape à 4KB
 *  pour rejeter les pastes pathologiques). */
export const MAX_KEYS_BYTES = 4_096;

/**
 * #464 — résout un consumer (via son cwd) en son nom de claude-loop. Le loop dir
 * vit à `~/.claude-loop/<loop_name>/` (overridable via `CLAUDE_LOOP_STATE_ROOT`)
 * ; chaque dir carries un `plate.json` avec la cwd du loop. Le consumer record
 * stocke son propre cwd (pushé via le state heartbeat), on bridge les deux par
 * la cwd canonique.
 */
export function resolveLoopName(cwd: string): string | null {
    const stateRoot = process.env.CLAUDE_LOOP_STATE_ROOT
        ?? join(homedir(), ".claude-loop");
    if (!existsSync(stateRoot)) return null;
    let entries: string[];
    try { entries = readdirSync(stateRoot); } catch { return null; }
    for (const dir of entries) {
        const platePath = join(stateRoot, dir, "plate.json");
        if (!existsSync(platePath)) continue;
        try {
            const plate = JSON.parse(readFileSync(platePath, "utf8")) as { cwd?: string };
            if (plate.cwd === cwd) return dir;
        } catch {
            /* ignore malformed plate */
        }
    }
    return null;
}

/** Tmux target pour le pane 0 du loop. */
export function paneTarget(loopName: string): string {
    return `${tmuxName(loopName)}.0`;
}

export interface CaptureResult {
    text: string;
    target: string;
    truncated: boolean;
    captured_at: string;
    /** #531 — pane's actual cursor position (`display-message #{cursor_x}` /
     *  `#{cursor_y}`, 0-based). The `capture-pane -e -p` snapshot doesn't
     *  always carry a positioning escape at its tail (psmux on Windows is
     *  one such case ; tmux on Linux tends to include one), so the
     *  consumer-side terminal must explicitly re-position the cursor after
     *  rendering the snapshot. `null` when the lookup fails (target gone,
     *  spawn errored). */
    cursor?: { x: number; y: number } | null;
    /** #1740 — the pane's own grid size. The snapshot is just text, so a
     *  consumer that renders it has no way to know how wide the source pane
     *  actually is : it can only size its terminal to its own container and
     *  show a WINDOW onto the pane. Carrying the geometry lets the frontend
     *  render the full grid and scale it down instead of cropping it.
     *  `null` when the lookup fails — the consumer then falls back to
     *  fitting its container, which is the pre-#1740 behaviour. */
    geometry?: PaneGeometry | null;
    /** #505 debug : exit code + stderr du `capture-pane` (utile pour repérer
     *  les sessions invalides ou les flags non supportés par psmux/Windows
     *  qui sortent 0 mais avec stdout vide). */
    debug?: { exit_code: number | null; stderr: string };
}

/** #1740 — pane grid size in cells (`#{pane_width}` × `#{pane_height}`). */
export interface PaneGeometry {
    cols: number;
    rows: number;
}

/**
 * Argv du lecteur de curseur, partagé par les variantes async et sync.
 *
 * La forme POSITIONNELLE est obligatoire, pas un choix de style : psmux
 * (Windows) ne connaît pas `-F` pour `display-message` et le traite comme un
 * mot du message. Il répond alors `-F 2,36` — avec un `exit 0` — et le parse
 * rejette la ligne. Le kernel avait sa propre copie en `-F` : sur Windows le
 * curseur valait donc `null` à CHAQUE poll, silencieusement, et la règle
 * curseur (celle qui distingue une suggestion grisée d'une vraie saisie) ne
 * s'exécutait jamais. Une commande qui réussit sans rien faire.
 */
export function cursorArgs(target: string): string[] {
    return ["display-message", "-p", "-t", target, "#{cursor_x},#{cursor_y}"];
}

export function parseCursor(stdout: string): { x: number; y: number } | null {
    const m = /^(\d+),(\d+)$/.exec(stdout.trim());
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

/**
 * #1740 — argv du lecteur de géométrie. Même forme positionnelle obligatoire
 * que `cursorArgs`, et pour la même raison (psmux ignore `-F`).
 *
 * C'est un appel SÉPARÉ de celui du curseur, pas un format à quatre champs :
 * si une version de psmux ne connaît pas `#{pane_width}`, elle répondra une
 * ligne que le parse rejette. Fusionner les deux ferait donc retomber le
 * curseur à `null` sur Windows — exactement la panne silencieuse que le
 * commentaire de `cursorArgs` documente. Deux appels, deux échecs
 * indépendants : perdre la miniature ne coûte pas le curseur.
 */
export function geometryArgs(target: string): string[] {
    return ["display-message", "-p", "-t", target, "#{pane_width},#{pane_height}"];
}

/**
 * Rejette zéro autant que le non-numérique : un pane à 0 colonne n'existe pas,
 * et le consommateur divise par ces valeurs pour calculer son échelle.
 */
export function parseGeometry(stdout: string): PaneGeometry | null {
    const m = /^(\d+),(\d+)$/.exec(stdout.trim());
    if (!m) return null;
    const cols = Number(m[1]);
    const rows = Number(m[2]);
    return cols > 0 && rows > 0 ? { cols, rows } : null;
}

/**
 * Spawn d'un `display-message -p` et récupération de son stdout. Partagé par
 * les lecteurs de curseur et de géométrie — même commande, même mode d'échec
 * (spawn raté ou exit non-nul → `null`, le lecteur retombe sur son défaut).
 */
function readDisplayMessage(args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
        const child = spawn(MUX_CMD, args, { stdio: ["ignore", "pipe", "ignore"] });
        const chunks: Buffer[] = [];
        child.stdout.on("data", (b: Buffer) => chunks.push(b));
        child.on("error", () => resolve(null));
        child.on("close", (code) => {
            if (code !== 0) return resolve(null);
            resolve(Buffer.concat(chunks).toString("utf8"));
        });
    });
}

/**
 * #1740 — fetch the pane's grid size (columns × rows). `null` on spawn /
 * parse failure ; the caller renders without geometry, which is the
 * pre-#1740 behaviour rather than an error.
 */
export async function captureGeometry(target: string): Promise<PaneGeometry | null> {
    const out = await readDisplayMessage(geometryArgs(target));
    return out === null ? null : parseGeometry(out);
}

/**
 * Variante synchrone, pour le poll du kernel (qui décide dans la foulée de la
 * capture et n'a pas de point d'await). Même commande, même parse.
 */
export function captureCursorSync(target: string): { x: number; y: number } | null {
    try {
        const r = spawnSync(MUX_CMD, cursorArgs(target), { encoding: "utf8" });
        if (r.status !== 0) return null;
        return parseCursor(r.stdout ?? "");
    } catch {
        return null;
    }
}

/**
 * #531 — fetch the pane's current cursor position (0-based column / row).
 * `psmux display-message -p '#{cursor_x},#{cursor_y}'` works on both psmux
 * (Windows) and tmux (Linux/macOS). Returns `null` on spawn / parse failure
 * — the caller falls back to whatever the snapshot positioned (or nothing).
 */
export async function captureCursor(target: string): Promise<{ x: number; y: number } | null> {
    const out = await readDisplayMessage(cursorArgs(target));
    return out === null ? null : parseCursor(out);
}

/**
 * Spawn `${MUX_CMD} capture-pane -e -p -t <target>` once. Returns the captured
 * text (ANSI preserved via `-e`) or an error. Capped at `MAX_PAYLOAD_BYTES`.
 * Async, non-blocking.
 *
 * Flags are passed separated (`-e -p`) rather than clustered (`-ep`):
 * psmux <= v3.3.4 silently dropped POSIX short-flag clusters in the
 * capture-pane CLI dispatcher (returned exit 0 + empty stdout). Fixed upstream
 * in psmux commit 72d08aa; passing separated flags works on every version.
 */
export async function captureOnce(target: string): Promise<CaptureResult | { error: string; target: string }> {
    // #531 — fetch content + cursor in parallel. capture-pane is the slow
    // call ; display-message is essentially free (~1 ms). Running them in
    // parallel keeps the tick latency at ~capture-pane's cost.
    // #1740 — the geometry read joins the same batch, for the same reason.
    const [contentR, cursor, geometry] = await Promise.all([
        captureContent(target),
        captureCursor(target),
        captureGeometry(target),
    ]);
    if ("error" in contentR) return contentR;
    contentR.cursor = cursor;
    contentR.geometry = geometry;
    return contentR;
}

function captureContent(target: string): Promise<CaptureResult | { error: string; target: string }> {
    return new Promise((resolve) => {
        const child = spawn(MUX_CMD, ["capture-pane", "-e", "-p", "-t", target], { stdio: ["ignore", "pipe", "pipe"] });
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        child.stdout.on("data", (b: Buffer) => {
            if (truncated) return;
            total += b.length;
            if (total > MAX_PAYLOAD_BYTES) {
                truncated = true;
                chunks.push(b.subarray(0, Math.max(0, MAX_PAYLOAD_BYTES - (total - b.length))));
                try { child.kill("SIGTERM"); } catch { /* noop */ }
            } else {
                chunks.push(b);
            }
        });
        child.stderr?.on("data", (b: Buffer) => { errChunks.push(b); });
        child.on("error", (e) => {
            resolve({ error: `spawn failed : ${e.message}`, target });
        });
        child.on("close", (code) => {
            const stderr = Buffer.concat(errChunks).toString("utf8").trim();
            if (code !== 0 && !truncated) {
                resolve({ error: `capture-pane exited ${code}${stderr ? ` (stderr: ${stderr})` : ""}`, target });
                return;
            }
            const text = Buffer.concat(chunks).toString("utf8");
            const result: CaptureResult = { text, target, truncated, captured_at: new Date().toISOString() };
            // Quand text est vide ET stderr non vide → ajoute le debug, sinon
            // on garde le payload minimal pour ne pas le polluer.
            if (text === "" && stderr) {
                result.debug = { exit_code: code, stderr: stderr.slice(0, 500) };
            }
            resolve(result);
        });
    });
}

/**
 * #472 — spawn `${MUX_CMD} send-keys -l -t <target> -- <keys>`. `-l` (literal)
 * passe chaque byte tel quel (un `\x03` reste un Ctrl-C). Async non-bloquant.
 */
export function sendKeys(target: string, keys: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
        const child = spawn(MUX_CMD, ["send-keys", "-l", "-t", target, "--", keys], { stdio: ["ignore", "ignore", "pipe"] });
        const errChunks: Buffer[] = [];
        child.stderr.on("data", (b: Buffer) => errChunks.push(b));
        child.on("error", (e) => resolve({ ok: false, error: e.message }));
        child.on("close", (code) => {
            if (code === 0) resolve({ ok: true });
            else resolve({ ok: false, error: `send-keys exited ${code}: ${Buffer.concat(errChunks).toString("utf8").trim()}` });
        });
    });
}
