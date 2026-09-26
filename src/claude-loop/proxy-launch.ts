/**
 * Which PTY proxy fronts claude, or a refusal.
 *
 * Pulled out of `cli.ts` as a pure function for the reason #1612/#1613 made
 * explicit: the branch that decides how claude is launched changes what the
 * whole loop can perceive, and it was reachable by no test at all. Here it
 * takes its inputs as data (platform, what exists on disk) so every outcome — including the refusal — is asserted without a
 * PTY, a mux, or a claude.
 *
 * The refusal is the point of this module. Until now a missing proxy fell
 * through to launching claude directly, which looks like it works: the pane
 * comes up, claude answers, and nothing says the loop has gone half-blind.
 * What it actually loses is not cosmetic — david `<chat>` 2026-09-07, "le
 * direct launch doit pas être possible, c'est trop impactant, ça doit
 * échouer":
 *
 *   - **live human-typing detection.** Only the proxy sees keystrokes as a
 *     separate stream; without it detection falls back to pane-diffing, which
 *     is idle-only, so typing during a busy turn is invisible (#a6wgdg).
 *   - **the AFK combo.** `AfkDetector` lives in the proxy and swallows the
 *     combo before claude — no proxy, no F9.
 *   - **clean wake injection.** `injectWakePhrase` falls back to
 *     `send-keys <phrase>` + `send-keys Enter` (state.ts), the interleaving-
 *     prone path that #1589 spent its life investigating.
 *
 * Each of those is silent when it breaks, which is what makes the fallback
 * worse than a failure: the loop keeps running and lies about what it can see.
 * So there is no opt-out. Not a config key, not an env var — david was
 * asked and answered "inconditionnel, pas de proxy pas de loop". A config key
 * that turns the guarantee off would be found by exactly the person who most
 * needs it on.
 */

/** What `cli.ts` should put in front of `claudeCmd`, or why it must not. */
export type ProxyLaunch =
    /** The Rust proxy, `cl-pty-proxy` — the only one, on every platform. */
    | { kind: "rust"; bin: string }
    /** No proxy is available: `claude-loop start` must die with `reason`. */
    | { kind: "refuse"; reason: string };

export interface ProxyLaunchInput {
    platform: NodeJS.Platform;
    /** Absolute path the Rust proxy has in this checkout once built. */
    rustProxyBin: string;
    /**
     * `CL_PROXY_BIN`: another built `cl-pty-proxy` to run instead — a packaged
     * install, or a container whose checkout is mounted from a host whose
     * binary it cannot run. It chooses WHICH proxy binary, never none: a path
     * that does not exist refuses like a missing build.
     */
    overrideBin?: string;
    /** Injected so the decision is testable without touching a filesystem. */
    exists: (path: string) => boolean;
}

/** The one-line build command, quoted verbatim in every refusal that a build
 *  would fix. Kept in one place so the error and the docs can't drift. */
export const BUILD_CMD =
    "cargo build --release --manifest-path windows/cl-pty-proxy/Cargo.toml";

/** What the loop gives up without a proxy. Prefixes every refusal: the reader
 *  needs to know why this is fatal rather than a warning they can dismiss. */
const WHY = [
    "the PTY proxy is not optional — without it the loop cannot see a human type",
    "while claude is busy, the AFK combo does not exist, and wakes are injected as",
    "raw keystrokes into your input box.",
].join("\n  ");

export function resolveProxyLaunch(input: ProxyLaunchInput): ProxyLaunch {
    const { platform, rustProxyBin, overrideBin, exists } = input;
    const bin = overrideBin?.trim() ? overrideBin.trim() : rustProxyBin;
    if (exists(bin)) return { kind: "rust", bin };
    const isWin = platform === "win32";
    if (overrideBin?.trim()) {
        return {
            kind: "refuse",
            reason: `no PTY proxy at CL_PROXY_BIN=${bin} — refusing to start.\n  ${WHY}\n`
                + `\n  Point CL_PROXY_BIN at a built cl-pty-proxy${isWin ? ".exe" : ""}, or unset it to use this checkout's build.\n`,
        };
    }
    return {
        kind: "refuse",
        reason:
            `no ${isWin ? "ConPTY" : "PTY"} proxy — refusing to start.\n  ${WHY}\n`
            + `\n  cl-pty-proxy${isWin ? ".exe" : ""} is not built. Build it with:\n`
            + `    ${BUILD_CMD}\n`
            + (isWin
                ? `\n  If that fails on 'dlltool' or 'CreateProcess', rustup's bundled GNU\n`
                  + `  toolchain is linker-only — see docs/WIN-INSTALL.md for the prerequisite.\n`
                : ""),
    };
}
