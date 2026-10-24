/**
 * #4141 — the git repositories a project's work spans beyond its checkout:
 * `repos:` in its `.aiball.yaml` (helios develops egui-pop beside it, in
 * `../egui-pop`). Resolved as `claude.config_dir` is: `~` and paths relative to
 * the folder. Only what the file names; nothing is guessed.
 */
import { loadConfig } from "./autopoll/config.js";
import { expandConfigDir } from "./claude-config-dir.js";

export function projectRepos(cwd: string): string[] {
    let declared: string[] = [];
    try { declared = loadConfig(cwd).repos; } catch { /* an unreadable config: none */ }
    return [...new Set(declared.map((r) => expandConfigDir(r, cwd)))];
}
