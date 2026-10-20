/**
 * `aiball claude-config [dir]` (#4120) — the Claude Code config dir a folder's
 * loops start Claude with (`claude.config_dir` in its `.aiball.yaml`): shown,
 * set, or unset; with `--move-sessions`, the folder's Claude sessions follow.
 */
import type { Command } from "commander";
import { die, gOpts, jsonline } from "./_helpers.js";
import { claudeConfigDir } from "../claude-config-dir.js";
import { moveClaudeSessions } from "../claude-config-move.js";
import { readSettings, writeSettings } from "../project-settings.js";
import { InitRefusal } from "../project-init.js";
import { startFolder, takeLaunchCwd } from "../claude-loop/start-guards.js";
import { relocateEnv } from "../relocate-env.js";
import { under } from "../relocate.js";

export function registerClaudeConfigCommands(program: Command): void {
    program
        .command("claude-config [dir]")
        .description(
            "The Claude Code config dir (CLAUDE_CONFIG_DIR: account, settings, MCP servers, sessions) a folder's loops start "
            + "Claude with. Without a dir: show it and where it comes from. With one: write `claude.config_dir` to the folder's "
            + ".aiball.yaml (~ and paths relative to the folder accepted). Takes effect at each loop's next restart.",
        )
        .option("--cwd <folder>", "The project folder (default: the current one)")
        .option("--unset", "Remove the setting: the environment's dir applies again, else ~/.claude")
        .option("--move-sessions", "Move the folder's Claude sessions (transcripts and its .claude.json entry) to the new dir, so they can be resumed there")
        .option("--json", "Machine-readable JSON output")
        .action((dir: string | undefined, opts: { cwd?: string; unset?: boolean; moveSessions?: boolean; json?: boolean }, cmd: Command) => {
            const json = opts.json || gOpts(cmd).json;
            const folder = startFolder(opts.cwd, takeLaunchCwd());
            try {
                if (dir === undefined && !opts.unset) {
                    const s = readSettings(folder);
                    if (json) jsonline({ folder, config_dir: s.config_dir.value, from: s.config_dir.from });
                    else process.stdout.write(`${folder}: ${s.config_dir.value} (${s.config_dir.from})\n`);
                    return;
                }
                if (dir !== undefined && opts.unset) die("give a dir or --unset, not both");
                const before = claudeConfigDir(folder);
                if (opts.moveSessions) {
                    // Claude writes to these while it runs: no Claude (nor loop) may run in the folder.
                    const procs = relocateEnv([], folder).processCwds();
                    const busy = (procs ?? []).filter((p) => under(p.cwd, folder) && /\bclaude\b/.test(p.cmd));
                    if (busy.length > 0) die(`Claude runs in ${folder} (${busy.map((p) => `${p.pid} ${p.cmd}`).join(", ")}): stop its loops first`);
                    if (procs === null) process.stderr.write(`! running processes cannot be listed here — make sure no Claude runs in ${folder}\n`);
                }
                const s = writeSettings(folder, { config_dir: opts.unset ? null : dir!.trim() });
                const after = claudeConfigDir(folder);
                const move = opts.moveSessions && after.dir !== before.dir ? moveClaudeSessions(folder, before, after) : null;
                if (json) {
                    jsonline({ folder, config_dir: s.config_dir.value, from: s.config_dir.from, previous: before.dir, sessions: move });
                    return;
                }
                const lines = [`${folder}: ${before.dir} → ${s.config_dir.value} (${s.config_dir.from})`];
                if (move) {
                    lines.push(`  sessions: ${move.moved} file(s) moved${move.kept.length ? `, ${move.kept.length} kept in the old dir (already in the new one)` : ""}`);
                    lines.push(`  .claude.json entry: ${move.projectEntry}`);
                } else if (after.dir !== before.dir) {
                    lines.push(`  the folder's sessions stay in ${before.dir}: --move-sessions moves them`);
                }
                if (after.dir !== before.dir) lines.push(`  restart the folder's loops (claude-loop restart <name>) for them to use it`);
                process.stdout.write(lines.join("\n") + "\n");
            } catch (e) {
                if (e instanceof InitRefusal) die(e.message);
                throw e;
            }
        });
}
