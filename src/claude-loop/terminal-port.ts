/**
 * #3066 3a — what the loop kernel does to the terminal Claude runs in, behind
 * one interface: whether it is still there, what its screen shows, typing
 * into it, ending it. Today's terminal is tmux, with the PTY proxy in between;
 * the session host is the second implementation. The kernel names neither for
 * these: it holds a `TerminalPort`.
 */
import { spawnSync } from "node:child_process";
import { captureCursorSync } from "../pane.js";
import { injectRawBytes, injectWakePhrase, MUX_CMD } from "./state.js";

export interface ScreenSnapshot {
    text: string;
    /** 0-based, visible-screen relative; null when unknown. */
    cursor: { x: number; y: number } | null;
}

export interface TerminalPort {
    readonly kind: "tmux";
    /** Whether Claude's terminal is still there. */
    alive(): boolean;
    /** The visible screen; empty text when it cannot be read. */
    screen(): ScreenSnapshot;
    /** A wake phrase, then Enter, delivered as the loop's own (never a human's) keys. */
    inject(phrase: string, onWillInject?: () => void): Promise<boolean>;
    /** Raw bytes to Claude: a key such as Esc, Enter or an arrow. */
    injectRaw(bytes: string): Promise<boolean>;
    /** End the terminal, and Claude with it. */
    end(): void;
}

/**
 * A spawn error on the liveness probe (the mux binary being replaced during
 * an upgrade, a brief PATH glitch) reads as "alive" this many times in a row
 * before the session is declared gone: the loop must not drop its presence
 * over a probe that did not run.
 */
const SPAWN_RETRY_LIMIT = 5;

/** The tmux session `session`, pane 0, with the PTY proxy under it. */
export function tmuxPort(opts: { session: string; stateDir: string | undefined; log: (msg: string) => void }): TerminalPort {
    const pane = `${opts.session}.0`;
    let consecutiveSpawnErr = 0;
    return {
        kind: "tmux",
        alive() {
            const r = spawnSync(MUX_CMD, ["has-session", "-t", opts.session], { stdio: "ignore" });
            if (r.error) {
                consecutiveSpawnErr++;
                if (consecutiveSpawnErr <= SPAWN_RETRY_LIMIT) {
                    opts.log(`tmux probe spawn error (${r.error.message}, streak ${consecutiveSpawnErr}/${SPAWN_RETRY_LIMIT}) — treating session as alive`);
                    return true;
                }
                opts.log(`tmux probe spawn error persisting (${SPAWN_RETRY_LIMIT}× in a row) — declaring session gone`);
                return false;
            }
            consecutiveSpawnErr = 0;
            return r.status === 0;
        },
        screen() {
            try {
                const r = spawnSync(MUX_CMD, ["capture-pane", "-t", pane, "-p"], { encoding: "utf8" });
                return { text: r.stdout ?? "", cursor: captureCursorSync(pane) };
            } catch {
                return { text: "", cursor: null };
            }
        },
        inject: (phrase, onWillInject) => injectWakePhrase(pane, phrase, onWillInject),
        injectRaw: (bytes) => injectRawBytes(opts.stateDir!, bytes),
        end() {
            try { spawnSync(MUX_CMD, ["kill-session", "-t", opts.session], { stdio: "ignore" }); } catch { /* tmux already gone */ }
        },
    };
}
