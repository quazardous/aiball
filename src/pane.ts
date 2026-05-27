/**
 * #505 phase 2 — partagé entre `src/api/agents.ts` (chemin local, agent qui
 * tourne sur le même host que le daemon) et la WS reverse côté node
 * (`src/proxy.ts`, agent qui tourne sur un node distant). Le contenu vient de
 * `agents.ts` d'origine (#464/#472) — extrait tel quel pour pouvoir l'appeler
 * depuis le handler WS sans embarquer Express.
 */
import { spawn } from "node:child_process";
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
    /** #505 debug : exit code + stderr du `capture-pane` (utile pour repérer
     *  les sessions invalides ou les flags non supportés par psmux/Windows
     *  qui sortent 0 mais avec stdout vide). */
    debug?: { exit_code: number | null; stderr: string };
}

/**
 * #464 — spawn `${MUX_CMD} capture-pane -ep -t <target>` une fois. Renvoie le
 * texte capturé (avec ANSI préservé, `-e`) ou une erreur. Borne la taille à
 * `MAX_PAYLOAD_BYTES`. Async non-bloquant.
 *
 * #505 fallback (`4r9q34`) : si la 1ʳᵉ tentative avec `-e` retourne text="" +
 * exit=0 + pas de stderr, on retry sans `-e`. Symptôme observé côté graphite
 * (psmux/Windows) : psmux peut accepter `-e` silencieusement mais sortir
 * stdout vide. Sans `-e` on perd les couleurs ANSI mais on récupère le texte.
 */
export async function captureOnce(target: string): Promise<CaptureResult | { error: string; target: string }> {
    const first = await captureOnceImpl(target, true);
    if ("error" in first) return first;
    if (first.text === "" && !first.debug) {
        // text vide + pas de stderr → essaye sans -e.
        const second = await captureOnceImpl(target, false);
        if ("error" in second) return first; // return first quand-même (au moins le timestamp est cohérent)
        if (second.text !== "") {
            second.debug = { exit_code: 0, stderr: `[fallback] -e returned empty; -p alone got ${second.text.length} bytes` };
            return second;
        }
    }
    return first;
}

function captureOnceImpl(target: string, withAnsi: boolean): Promise<CaptureResult | { error: string; target: string }> {
    return new Promise((resolve) => {
        const args = withAnsi ? ["capture-pane", "-ep", "-t", target] : ["capture-pane", "-p", "-t", target];
        const child = spawn(MUX_CMD, args, { stdio: ["ignore", "pipe", "pipe"] });
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
