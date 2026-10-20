/**
 * `aiball claude-config [dir]` (#4120) — the Claude Code config dir a folder's
 * loops start Claude with (`claude.config_dir` in its `.aiball.yaml`): shown,
 * set, or unset; with `--move-sessions`, the folder's Claude sessions follow;
 * with `--fork` (#4125), the new dir starts with the old one's instructions,
 * skills, settings and MCP servers, never its account nor its sessions —
 * linked to the old dir's (#4126), or copied with `--copy`.
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { die, gOpts, jsonline } from "./_helpers.js";
import { claudeConfigDir, expandConfigDir } from "../claude-config-dir.js";
import { moveClaudeSessions } from "../claude-config-move.js";
import { forkClaudeConfig, type ForkResult } from "../claude-config-fork.js";
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
        .option("--fork", "Start the new dir with the old one's mind: CLAUDE.md and its imports, skills, agents, commands, plugins, settings.json, the user MCP servers. Never its credentials, account or sessions. Linked to the old dir's entries, so their updates reach both; settings.json, which Claude writes, is copied")
        .option("--copy", "With --fork: copy everything instead of linking; the new dir then lives its own life")
        .option("--fork-from <dir>", "Fork from this dir rather than the old one; without a dir argument, fork into the folder's current dir")
        .option("--force", "With --fork: replace what the new dir already has; its own entries are moved aside into .replaced-by-fork-<date>/, never deleted")
        .option("--json", "Machine-readable JSON output")
        .action((dir: string | undefined, opts: { cwd?: string; unset?: boolean; moveSessions?: boolean; fork?: boolean; forkFrom?: string; force?: boolean; copy?: boolean; json?: boolean }, cmd: Command) => {
            const json = opts.json || gOpts(cmd).json;
            const folder = startFolder(opts.cwd, takeLaunchCwd());
            try {
                if (dir === undefined && !opts.unset && opts.forkFrom !== undefined) {
                    // Fork into the dir the folder already uses.
                    const to = claudeConfigDir(folder);
                    const fromDir = expandConfigDir(opts.forkFrom, folder);
                    if (fromDir === to.dir) die(`${fromDir} is already the folder's dir`);
                    const fork = forkClaudeConfig(sourceDir(fromDir), to, { force: opts.force, copy: opts.copy });
                    if (json) jsonline({ folder, config_dir: to.dir, fork: { from: fromDir, ...fork } });
                    else process.stdout.write([`${folder}: ${fromDir} → ${to.dir} (fork)`, ...forkLines(fork)].join("\n") + "\n");
                    return;
                }
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
                const forkFrom = opts.forkFrom !== undefined
                    ? sourceDir(expandConfigDir(opts.forkFrom, folder))
                    : before;
                const fork = (opts.fork || opts.forkFrom !== undefined) && after.dir !== forkFrom.dir ? forkClaudeConfig(forkFrom, after, { force: opts.force, copy: opts.copy }) : null;
                if (json) {
                    jsonline({ folder, config_dir: s.config_dir.value, from: s.config_dir.from, previous: before.dir, sessions: move, fork: fork && { from: forkFrom.dir, ...fork } });
                    return;
                }
                const lines = [`${folder}: ${before.dir} → ${s.config_dir.value} (${s.config_dir.from})`];
                if (move) {
                    lines.push(`  sessions: ${move.moved} file(s) moved${move.kept.length ? `, ${move.kept.length} kept in the old dir (already in the new one)` : ""}`);
                    lines.push(`  .claude.json entry: ${move.projectEntry}`);
                } else if (after.dir !== before.dir) {
                    lines.push(`  the folder's sessions stay in ${before.dir}: --move-sessions moves them`);
                }
                if (fork) lines.push(`  fork from ${forkFrom.dir}:`, ...forkLines(fork));
                if (after.dir !== before.dir) lines.push(`  restart the folder's loops (claude-loop restart <name>) for them to use it`);
                process.stdout.write(lines.join("\n") + "\n");
            } catch (e) {
                if (e instanceof InitRefusal) die(e.message);
                throw e;
            }
        });
}

/** A dir named by hand: ~/.claude keeps its .claude.json beside it, in the home, as Claude does without CLAUDE_CONFIG_DIR. */
function sourceDir(dir: string): { dir: string; json: string } {
    const inside = join(dir, ".claude.json");
    if (resolve(dir) === join(homedir(), ".claude") && !existsSync(inside)) return { dir, json: join(homedir(), ".claude.json") };
    return { dir, json: inside };
}

function forkLines(f: ForkResult): string[] {
    const out: string[] = [];
    if (f.linked.length) out.push(`  linked: ${f.linked.join(", ")}`);
    if (f.copied.length) out.push(`  copied: ${f.copied.join(", ")}`);
    if (!f.linked.length && !f.copied.length) out.push("  nothing linked or copied");
    if (f.movedAside) out.push(`  replaced, the new dir's own moved into ${f.movedAside}`);
    if (f.mcpServers) out.push(`  MCP servers: ${f.mcpServers}`);
    if (f.kept.length) out.push(`  already there, kept (--force overwrites): ${f.kept.join(", ")}`);
    if (f.unknown.length) out.push(`  not copied, not known: ${f.unknown.join(", ")}`);
    out.push(`  never carried: the credentials, the account, the sessions and history`);
    return out;
}
