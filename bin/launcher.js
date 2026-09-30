/**
 * Shared launcher behind every `bin/` entrypoint (#1567 — volet Linux).
 *
 * It replaces the hand-written bash launchers, which each re-implemented the
 * same four steps — resolve the install root through symlinks, remember the
 * caller's cwd, resolve the local-trust transport, run the TS entry via tsx —
 * once per command, and once more per platform in the `.cmd` twins. One module
 * now owns those steps for every command, and npm's `bin` field generates the
 * platform shims that used to be maintained by hand.
 *
 * It also flattens the process tree. The bash launcher exec'd
 * `npx --no-install tsx <entry>`, leaving bash → npx → tsx → node; here tsx is
 * registered as an ESM loader IN this process and the entry is imported, so the
 * command *is* the node process. One less layer between a pid and the code it
 * runs — precisely the confusion that made `timer.pid` point at a wrapper.
 *
 * Note this only covers the top-level user-facing entrypoints. The processes
 * claude-loop spawns for itself (timer, hooks) already call
 * `node_modules/.bin/tsx` by absolute path and are untouched by this file.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Install root — this file is `<root>/bin/launcher.js`.
 *
 * Node resolves the symlink chain before handing us `import.meta.url`, so a
 * `~/.local/bin/aiball → ~/.local/lib/aiball/bin/aiball` symlink lands on the
 * install dir with no work. That is exactly what the bash `while [[ -L ]]` loop
 * was doing by hand.
 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the daemon keeps its socket, token and DB. */
function aiballHome() {
    return (
        process.env.AIBALL_HOME ??
        join(process.env.HOME ?? homedir(), ".local", "share", "aiball")
    );
}

/**
 * Read the shell-format `cli-env` file the way `source` did, minus the shell.
 * The file is written by `aiball auth issue` as `export KEY=value` lines; we
 * only set what isn't already in the environment, so an explicit
 * `AIBALL_TOKEN=… aiball …` still wins.
 */
function loadCliEnv(file) {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (!m) continue;
        let value = m[2].trim();
        // One layer of matching quotes: `export X="v"` is valid in the file.
        if (
            value.length >= 2 &&
            ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'")))
        ) {
            value = value.slice(1, -1);
        }
        if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
}

function isSocket(path) {
    try {
        return statSync(path).isSocket();
    } catch {
        return false;
    }
}

/**
 * Run one of the TS entrypoints under `src/`.
 *
 * @param {string} entryRel Path to the entry, relative to the install root.
 */
/**
 * Will the client authenticate with the machine secret? It does when the daemon
 * is on this machine (a loopback AIBALL_URL, or none) and the daemon wrote the
 * secret — the TCP counterpart of the socket (Windows has no socket). The
 * client (src/client.ts) reads it itself; this only keeps `cli-env` from
 * taking precedence, as the socket does.
 */
function usesMachineSecret(home) {
    let host = "127.0.0.1";
    try { if (process.env.AIBALL_URL) host = new URL(process.env.AIBALL_URL).hostname.replace(/^\[|\]$/g, ""); } catch { return false; }
    const loopback = host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
    return loopback && existsSync(join(home, "machine-secret"));
}

export async function launch(entryRel) {
    // The caller's cwd, captured before we move into the install root: every
    // subcommand that walks up from the user's project (autopoll, check, the
    // MCP welcome resolver) starts from here. The TS side reads AIBALL_CWD and
    // falls back to process.cwd().
    process.env.AIBALL_CWD = process.cwd();
    // The same folder, for `claude-loop start` alone: it reads and drops this
    // one, so a loop never starts in a folder inherited from another loop's
    // shell (AIBALL_CWD is exported inside every loop).
    process.env.AIBALL_LAUNCH_CWD = process.cwd();

    const home = aiballHome();

    // Local-trust transport: prefer the daemon's Unix socket (same uid, chmod
    // 600, no token in sight). The bearer token is the fallback for when the
    // socket isn't there — an older daemon, or a remote box over an SSH tunnel.
    const sock = join(home, "sock");
    if (!process.env.AIBALL_SOCK && isSocket(sock)) process.env.AIBALL_SOCK = sock;
    if (!process.env.AIBALL_SOCK && !process.env.AIBALL_TOKEN && !usesMachineSecret(home)) {
        const cliEnv = join(home, "cli-env");
        if (existsSync(cliEnv)) loadCliEnv(cliEnv);
    }

    process.chdir(ROOT);

    const { register } = await import("tsx/esm/api");
    register();
    // A command typed in a folder that names its agent, from a shell carrying
    // another agent's identity, stops here (src/identity-guard.ts).
    const { enforceFolderIdentity } = await import(pathToFileURL(join(ROOT, "src/identity-guard.ts")).href);
    enforceFolderIdentity(entryRel);
    await import(pathToFileURL(join(ROOT, entryRel)).href);
}
