/**
 * #600 — shared option registry for the `init` surfaces that bootstrap
 * a project. Three commander.js sites used to redeclare the same flags
 * by hand :
 *   - `aiball init`               (src/cli/bootstrap.ts)
 *   - `claude-loop init`          (src/claude-loop/cli.ts)
 *   - `claude-loop start --init`  (same, with `--init-` prefix on each)
 *
 * Adding a new bootstrap flag meant touching all 3 sites + the
 * `StartOpts` type ; david `dazyst` 2026-06-03 flagged it as duplication
 * mécanique. Now each entry lives once here and the surfaces consume it
 * via `applyBootstrapOptions` / `applyInitForwardOptions`.
 *
 * Per david `7yn28d` `483um7` 2026-06-03 : `aiball init` reste pour le
 * mode node/daemon, `claude-loop init` reste le path quotidien projet —
 * les deux surfaces sont LÉGITIMES, on dédupe juste les déclarations.
 */
import type { Command } from "commander";

/**
 * One bootstrap flag declaration. `description` is shown in `--help` ;
 * `forwardKey` is the camelCase key on the commander opts object (lets
 * the start --init forwarder remap `--init-private` back to `private`
 * when calling `bootstrapInit`).
 */
export interface BootstrapOption {
    /** Long flag + optional value name. Example : `"--private"` or
     *  `"--agent <id>"`. The leading `--` is required. */
    flag: string;
    description: string;
    /** When `claude-loop start --init` forwards flags via the `--init-*`
     *  prefix, we strip the prefix and feed the resulting camelCase key
     *  to `bootstrapInit`. `forwardKey` is the post-prefix-strip camelCase
     *  for explicit mapping (`"private"` for `--init-private`, etc.). */
    forwardKey: string;
}

/** Flags shared by every project-bootstrap surface (aiball init,
 *  claude-loop init, claude-loop start --init). The order here is the
 *  order they appear in `--help`. */
export const BOOTSTRAP_OPTIONS: ReadonlyArray<BootstrapOption> = [
    {
        flag: "--force",
        description: "Overwrite existing entries (passes through to mcp + autopoll write paths)",
        forwardKey: "force",
    },
    {
        flag: "--stop-hook",
        description: "Also wire Claude Code's Stop hook into .claude/settings.json so this project's autopoll triggers",
        forwardKey: "stopHook",
    },
    {
        flag: "--global",
        description: "With --stop-hook, write to ~/.claude/settings.json instead of <PWD>/.claude/settings.json (fires in every Claude Code session)",
        forwardKey: "global",
    },
    {
        flag: "--private",
        description: "#593: seed .aiball.yaml with `project_type: private` so the welcome MCP serves the private kit",
        forwardKey: "private",
    },
    {
        flag: "--agent <id>",
        description: "#603: seed `consumer.agent` in .aiball.yaml (loop identity). Patches an existing file in place.",
        forwardKey: "agent",
    },
    {
        flag: "--consumer <id>",
        description: "#603: alias for --agent (the consumer_id IS the loop identity).",
        forwardKey: "consumer",
    },
    {
        flag: "--project <name>",
        description: "#603: seed `consumer.project` in .aiball.yaml (default project for this checkout).",
        forwardKey: "project",
    },
    {
        flag: "--no-claim",
        description: "#612: seed `consumer.no_claim: true` in .aiball.yaml (assignment-only agent — no claimable pool).",
        forwardKey: "noClaim",
    },
    {
        flag: "--migrate-from <name>",
        description: "#701: rename the project from <name> to the new project name BEFORE the init body runs. Typo-recovery in one shot.",
        forwardKey: "migrateFrom",
    },
];

/** Apply every shared bootstrap option to `cmd` in registry order.
 *  Used by `aiball init` and `claude-loop init`. */
export function applyBootstrapOptions(cmd: Command): Command {
    for (const opt of BOOTSTRAP_OPTIONS) {
        cmd.option(opt.flag, opt.description);
    }
    return cmd;
}

/** Apply the shared bootstrap options to `claude-loop start`, prefixed
 *  with `--init-` (so `--private` becomes `--init-private` etc.), and
 *  silently mark them as init-forward flags. `claude-loop start` only
 *  honors them when `--init` is also set. */
export function applyInitForwardOptions(cmd: Command): Command {
    for (const opt of BOOTSTRAP_OPTIONS) {
        if (opt.flag === "--no-claim") continue;        // commander tri-state — keep its own decl path on start
        if (opt.flag.startsWith("--migrate-from")) continue;  // start path doesn't migrate
        if (opt.flag === "--agent <id>") continue;      // start has its own --agent for the runtime
        if (opt.flag === "--consumer <id>") continue;   // idem
        if (opt.flag === "--project <name>") continue;  // idem
        const prefixed = opt.flag.replace(/^--/, "--init-");
        cmd.option(prefixed, `${opt.description} (use with --init)`);
    }
    return cmd;
}

/** Pluck bootstrap-related fields from a flat commander opts object —
 *  used by the start --init forwarder to build the `bootstrapInit` call
 *  from `opts.init*` flags. Returns only the keys present (undefined
 *  fields stay out so they don't clobber existing yaml). */
export function pluckInitForward(opts: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const opt of BOOTSTRAP_OPTIONS) {
        const initKey = `init${opt.forwardKey.charAt(0).toUpperCase()}${opt.forwardKey.slice(1)}`;
        if (opts[initKey] !== undefined) {
            out[opt.forwardKey] = opts[initKey];
        }
    }
    return out;
}
