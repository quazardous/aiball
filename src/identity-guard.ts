/**
 * #3389 — a command typed in a folder that names its agent, from a shell that
 * carries another agent's identity, is refused.
 *
 * `AIBALL_AGENT` / `AIBALL_PROJECT` win over the folder's `.aiball.yaml` when
 * the identity is resolved: inside a loop's shell, `cd ../other-project` then
 * `aiball ticket new …` posted as the loop's agent, in the loop's project, and
 * nothing said so. The rule is applied once, by the launcher, to the folder the
 * command was typed in — not inside the identity resolution, which tests and
 * the daemon call with identities of their own.
 *
 * Not refused:
 * - a folder with no `.aiball.yaml`, or one that names no agent: the
 *   environment decides, as before;
 * - a shell that belongs to a loop running in this folder (its crew agents,
 *   its MCP server): the loop's own identity is the one to use there;
 * - `--as <agent>` naming the agent the shell carries, or
 *   `AIBALL_ALLOW_FOREIGN_AGENT=1` for a script: "I know what I am doing".
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { findConfigUpwards } from "./autopoll/config.js";

export interface IdentityFacts {
    /** The command as the user typed it: `aiball`, `claude-loop`, `aiball-mcp`. */
    command: string;
    /** The nearest `.aiball.yaml` at or above the typed folder, and what it names. */
    folder: { file: string; agent: string | null; project: string | null } | null;
    envAgent: string | undefined;
    envProject: string | undefined;
    /** The loop this shell belongs to, when its folder is the typed folder or above it. */
    ownLoop: boolean;
    /** The loop whose shell this is, for the message. */
    loopName: string | null;
    /** `--as <agent>`. */
    as: string | undefined;
    /** `AIBALL_ALLOW_FOREIGN_AGENT=1`. */
    allow: boolean;
}

export type IdentityVerdict =
    | { kind: "ok" }
    | { kind: "allowed"; warning: string }
    | { kind: "refused"; message: string };

export function judgeIdentity(f: IdentityFacts): IdentityVerdict {
    const folder = f.folder;
    if (!folder?.agent) return { kind: "ok" };
    const foreignAgent = !!f.envAgent && f.envAgent !== folder.agent;
    const foreignProject = !!f.envProject && !!folder.project && f.envProject !== folder.project;
    if (!foreignAgent && !foreignProject) return { kind: "ok" };
    if (f.ownLoop || f.allow) return { kind: "ok" };

    const carried = f.envAgent ?? folder.agent;
    const what = foreignAgent
        ? `${f.envAgent} (AIBALL_AGENT${f.loopName ? `, from the loop ${f.loopName}` : ""})`
        : `the project ${f.envProject} (AIBALL_PROJECT${f.loopName ? `, from the loop ${f.loopName}` : ""}), not ${folder.project}`;
    if (f.as !== undefined) {
        if (f.as === carried) {
            return { kind: "allowed", warning: `${f.command}: acting as ${what} in ${folder.agent}'s folder (${folder.file}), as asked with --as` };
        }
        return {
            kind: "refused",
            message: `${f.command}: REFUSED — --as ${f.as} does not name the agent this shell carries, ${carried}.\n`
                + `  This folder is ${folder.agent}'s (${folder.file}).\n`
                + `  To act as ${carried} here on purpose: --as ${carried}`,
        };
    }
    return {
        kind: "refused",
        message: `${f.command}: REFUSED — this folder is ${folder.agent}'s (${folder.file}),\n`
            + `  but this shell carries ${what}.\n`
            + `  Run it from a shell of this project, or unset AIBALL_AGENT / AIBALL_PROJECT.\n`
            + `  To act as ${carried} here on purpose: --as ${carried}   (a script: AIBALL_ALLOW_FOREIGN_AGENT=1)`,
    };
}

/** Removes `--as <agent>` / `--as=<agent>` from `argv` (before any `--`) and returns the agent. */
export function takeAsFlag(argv: string[]): string | undefined {
    const end = argv.indexOf("--");
    for (let i = 2; i < (end === -1 ? argv.length : end); i++) {
        if (argv[i] === "--as" && i + 1 < argv.length) return argv.splice(i, 2)[1];
        if (argv[i].startsWith("--as=")) return argv.splice(i, 1)[0].slice("--as=".length);
    }
    return undefined;
}

function canonical(p: string): string {
    try { return realpathSync(p); } catch { return p; }
}

/** Is `path` the folder `root`, or inside it? By the paths themselves: `\` and `/` alike on Windows. */
function within(path: string, root: string): boolean {
    const rel = relative(canonical(root), canonical(path));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function readFolder(typedCwd: string): IdentityFacts["folder"] {
    const file = findConfigUpwards(typedCwd);
    if (!file) return null;
    try {
        const consumer = ((parseYaml(readFileSync(file, "utf8")) ?? {}) as { consumer?: Record<string, unknown> }).consumer ?? {};
        const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
        return { file, agent: str(consumer.agent), project: str(consumer.project) };
    } catch {
        return null;
    }
}

function readOwnLoop(typedCwd: string, env: NodeJS.ProcessEnv): { ownLoop: boolean; loopName: string | null } {
    const sd = env.CL_STATE_DIR;
    if (!sd) return { ownLoop: false, loopName: null };
    const loopName = basename(sd);
    try {
        const plate = JSON.parse(readFileSync(join(sd, "plate.json"), "utf8")) as { cwd?: unknown };
        return { ownLoop: typeof plate.cwd === "string" && existsSync(plate.cwd) && within(typedCwd, plate.cwd), loopName };
    } catch {
        return { ownLoop: false, loopName };
    }
}

/**
 * The commands that say what is wrong rather than act under an identity, and
 * `claude-loop start`, which drops an inherited identity itself and has its
 * own refusals (#3175, #3360).
 */
function exempt(command: string, argv: string[]): boolean {
    // `aiball --human` acts as the human moderator, not as the shell's agent.
    if (command === "aiball" && argv.slice(2).some((a) => a === "--human" || a === "-H")) return true;
    const first = argv.slice(2).find((a) => !a.startsWith("-"));
    if (first === undefined) return true; // bare command, `--version`, `--help`
    if (["check", "version", "help"].includes(first)) return true;
    return command === "claude-loop" && first === "start";
}

/** For `--help`: the flag is taken by the launcher, so no command declares it. */
export const AS_HELP = "\nIn a folder whose .aiball.yaml names another agent than this shell's AIBALL_AGENT:\n"
    + "  --as <agent>   run the command as the agent this shell carries, on purpose";

const COMMANDS: Record<string, string> = {
    "src/cli.ts": "aiball",
    "src/mcp.ts": "aiball-mcp",
    "src/claude-loop/cli.ts": "claude-loop",
};

/**
 * Called by the launcher before a client command runs. `entry` is the entry
 * it is about to load; the daemon is not a client and is never judged.
 * Takes `--as` out of `argv` either way, so no command has to know it.
 */
export function enforceFolderIdentity(entry: string, argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): void {
    const command = COMMANDS[entry];
    if (!command) return;
    const as = takeAsFlag(argv);
    // The MCP server takes no command: it is judged whatever its arguments.
    if (command !== "aiball-mcp" && exempt(command, argv)) return;
    const typedCwd = env.AIBALL_LAUNCH_CWD ?? env.AIBALL_CWD ?? process.cwd();
    const verdict = judgeIdentity({
        command,
        folder: readFolder(typedCwd),
        envAgent: env.AIBALL_AGENT || undefined,
        envProject: env.AIBALL_PROJECT || undefined,
        ...readOwnLoop(typedCwd, env),
        as,
        allow: env.AIBALL_ALLOW_FOREIGN_AGENT === "1",
    });
    if (verdict.kind === "refused") {
        process.stderr.write(`${verdict.message}\n`);
        process.exit(2);
    }
    if (verdict.kind === "allowed") process.stderr.write(`${verdict.warning}\n`);
}
