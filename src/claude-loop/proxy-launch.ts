/**
 * Which PTY proxy fronts claude, or a refusal.
 *
 * Pulled out of `cli.ts` as a pure function for the reason #1612/#1613 made
 * explicit: the branch that decides how claude is launched changes what the
 * whole loop can perceive, and it was reachable by no test at all. Here it
 * takes its inputs as data (platform, what exists on disk, whether python3
 * resolves) so every outcome — including the refusal — is asserted without a
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
 * So there is no opt-out. Not `proxy_impl: none`, not an env var — david was
 * asked and answered "inconditionnel, pas de proxy pas de loop". A config key
 * that turns the guarantee off would be found by exactly the person who most
 * needs it on.
 */

/** What `cli.ts` should put in front of `claudeCmd`, or why it must not. */
export type ProxyLaunch =
    /** The Rust proxy — the reference implementation on both platforms. */
    | { kind: "rust"; bin: string }
    /** The deprecated Python fallback (POSIX only). `notice` is printed. */
    | { kind: "python"; script: string; notice: string }
    /** No proxy is available: `claude-loop start` must die with `reason`. */
    | { kind: "refuse"; reason: string };

export interface ProxyLaunchInput {
    platform: NodeJS.Platform;
    /** `claude_loop.proxy_impl` / `CL_PROXY_IMPL`, already trimmed + lowercased. */
    proxyImpl: string;
    /** Absolute path the Rust proxy WOULD have if it were built. */
    rustProxyBin: string;
    /** Absolute path of `pty-proxy.py` in this checkout. */
    pyProxy: string;
    /** Injected so the decision is testable without touching a filesystem. */
    exists: (path: string) => boolean;
    /** Whether `python3` resolves on PATH. */
    hasPython3: boolean;
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
    const { platform, proxyImpl, rustProxyBin, pyProxy, exists, hasPython3 } = input;
    const isWin = platform === "win32";
    const wantsPython = proxyImpl === "python";
    const rustBuilt = exists(rustProxyBin);

    // Windows is always Rust: there is no Python proxy there (pty.fork() is
    // POSIX), so `proxy_impl: python` can only be a config left over from a
    // Unix checkout. Say that rather than reporting a generic miss.
    if (isWin) {
        if (rustBuilt) return { kind: "rust", bin: rustProxyBin };
        return {
            kind: "refuse",
            reason:
                `no ConPTY proxy — refusing to start.\n  ${WHY}\n`
                + `\n  cl-pty-proxy.exe is not built. Build it with:\n`
                + `    ${BUILD_CMD}\n`
                + `\n  If that fails on 'dlltool' or 'CreateProcess', rustup's bundled GNU\n`
                + `  toolchain is linker-only — see docs/WIN-INSTALL.md for the prerequisite.\n`,
        };
    }

    if (!wantsPython && rustBuilt) return { kind: "rust", bin: rustProxyBin };

    if (hasPython3 && exists(pyProxy)) {
        return {
            kind: "python",
            script: pyProxy,
            // Deprecated path. Say so out loud — a silent fallback is how the two
            // implementations drifted apart in the first place (#1294).
            notice: wantsPython
                ? "claude-loop: using the DEPRECATED Python PTY proxy (proxy_impl: python).\n"
                : "claude-loop: Rust PTY proxy not built — falling back to the DEPRECATED Python proxy.\n"
                  + `  Build it with: ${BUILD_CMD}\n`,
        };
    }

    // Unix with neither engine. Name both fixes: the Rust build is the one we
    // want taken, python3 is what unblocks a machine that can't build Rust.
    return {
        kind: "refuse",
        reason:
            `no PTY proxy — refusing to start.\n  ${WHY}\n`
            + (wantsPython
                ? "\n  proxy_impl: python was asked for, but python3 does not resolve on PATH.\n"
                : "\n  cl-pty-proxy is not built and python3 does not resolve on PATH.\n")
            + `\n  Build the Rust proxy (preferred):\n    ${BUILD_CMD}\n`
            + `  Or install python3 for the deprecated fallback.\n`,
    };
}
