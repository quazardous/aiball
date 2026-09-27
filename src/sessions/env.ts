/**
 * #3066 — the environment Claude starts with under a session host. The daemon
 * runs under systemd, with a poorer environment than a login shell: the user's
 * tools (nvm, bun…) would be missing. So a session starts with the user's login
 * environment, read once, over which a local caller's variables apply — only
 * those of an allow-list: from another machine, an environment is a way to run
 * code on this one.
 */
import { spawnSync } from "node:child_process";

let login: Record<string, string> | null = null;

/** The login shell's environment, read once; the daemon's own when the shell fails. */
export function loginEnv(): Record<string, string> {
    if (login) return login;
    const shell = process.env.SHELL || "/bin/sh";
    const r = spawnSync(shell, ["-lc", "env -0"], { encoding: "utf8", timeout: 10_000 });
    const out: Record<string, string> = {};
    if (r.status === 0 && r.stdout) {
        for (const pair of r.stdout.split("\0")) {
            const i = pair.indexOf("=");
            if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
        }
    }
    login = Object.keys(out).length > 0 ? out : { ...(process.env as Record<string, string>) };
    return login;
}

/**
 * The variables a local caller may set for the command it starts. #3125 — and
 * the keys the session host watches for a loop (the AFK key and its window,
 * ESC taking over, the reload key): the host reads them from its own
 * environment, so they must reach it rather than only the shell inside.
 */
const ALLOWED = [
    /^PATH$/, /^LANG$/, /^LC_[A-Z_]+$/, /^TERM$/, /^COLORTERM$/, /^(HTTP|HTTPS|NO|ALL)_PROXY$/i, /^NVM_[A-Z_]+$/, /^BUN_INSTALL$/, /^EDITOR$/, /^VISUAL$/, /^TZ$/,
    /^CL_AFK_SPEC$/, /^CL_AFK_WINDOW_MS$/, /^CL_ESC_TAKEOVER$/, /^CL_RELOAD_KEY$/,
];

export function allowedEnv(given: Record<string, unknown> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(given ?? {})) {
        if (typeof v === "string" && ALLOWED.some((re) => re.test(k))) out[k] = v;
    }
    return out;
}

/**
 * #3125 — the environment of a session on the host: the user's login
 * environment, what a local caller may set, and a terminal that renders
 * colours. The daemon runs without a terminal, so `TERM` would be missing and
 * everything in the session black and white; the host's clients (tvty, a
 * terminal attached to it) render 256 colours and true colour.
 */
export function sessionEnv(given: Record<string, unknown> | undefined, local: boolean): Record<string, string> {
    const env: Record<string, string> = { ...loginEnv(), ...(local ? allowedEnv(given) : {}) };
    if (!env.TERM || env.TERM === "dumb") env.TERM = "xterm-256color";
    if (!env.COLORTERM) env.COLORTERM = "truecolor";
    return env;
}

/** Tests only. */
export function resetLoginEnvForTests(e: Record<string, string> | null): void {
    login = e;
}
