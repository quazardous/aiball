/**
 * `aiball backup <dir>` / `aiball restore <dir> [--dry-run]` (#2466).
 * The rules live in `src/backup.ts`; this wires paths, the daemon probe and output.
 */
import type { Command } from "commander";
import { dirname, resolve } from "node:path";
import { die, gOpts, jsonline } from "./_helpers.js";

async function paths(): Promise<{ home: string; configDir: string }> {
    const { AIBALL_HOME } = await import("../paths.js");
    const { globalConfigPath } = await import("../autopoll/config.js");
    return { home: AIBALL_HOME, configDir: dirname(globalConfigPath()) };
}

/** Is a daemon answering on this home? A restore under a live daemon is refused. */
async function daemonUp(): Promise<boolean> {
    const { AiballClient } = await import("../client.js");
    try {
        await new AiballClient({ timeoutMs: 1500 }).health();
        return true;
    } catch {
        return false;
    }
}

export function registerBackupCommands(program: Command): void {
    program
        .command("backup <dir>")
        .description(
            "Back up the board into a new or empty directory: a consistent snapshot of the database (safe while the daemon runs), "
            + "uploads, spool, cli-env and the global config, with a manifest of versions, row counts and sha256. "
            + "The backup holds secrets (tokens, payloads): it is written 0700/0600.",
        )
        .option("--json", "Machine-readable JSON output")
        .action(async (dir: string, opts: { json?: boolean }, cmd: Command) => {
            const { createBackup } = await import("../backup.js");
            const { AIBALL_VERSION } = await import("../version.js");
            const dest = resolve(dir);
            try {
                const m = await createBackup({ ...(await paths()), dest, aiballVersion: AIBALL_VERSION });
                if (opts.json || gOpts(cmd).json) {
                    jsonline({ dest, ...m });
                    return;
                }
                const files = Object.keys(m.files).length;
                process.stdout.write(
                    `backup written to ${dest}\n`
                    + `  ${files} files, ${m.row_counts.tickets ?? "?"} tickets, integrity ok\n`
                    + `  aiball ${m.aiball_version}, created ${m.created_at}\n`
                    + `  it holds secrets: keep it private\n`,
                );
            } catch (e) {
                die(`backup: ${(e as Error).message}`);
            }
        });

    program
        .command("restore <dir>")
        .description(
            "Restore a backup made by `aiball backup`. Checks the manifest (sha256, database integrity, schema not newer than this install) "
            + "before touching anything; refuses while the daemon runs; sets the current data and config aside as `<dir>.pre-restore-<date>`.",
        )
        .option("--dry-run", "Only check the backup; change nothing")
        .option("--json", "Machine-readable JSON output")
        .action(async (dir: string, opts: { dryRun?: boolean; json?: boolean }, cmd: Command) => {
            const { applyRestore, readKnownMigrations, verifyBackup } = await import("../backup.js");
            const { migrationsFolder } = await import("../db/connection.js");
            const src = resolve(dir);
            const json = opts.json || gOpts(cmd).json;
            const { manifest, errors } = verifyBackup(src, readKnownMigrations(migrationsFolder()));
            if (errors.length > 0 || !manifest) {
                if (json) jsonline({ ok: false, errors });
                die(`restore: the backup was not trusted, nothing was changed:\n  - ${errors.join("\n  - ")}`);
            }
            if (opts.dryRun) {
                if (json) {
                    jsonline({ ok: true, dry_run: true, manifest });
                    return;
                }
                process.stdout.write(
                    `backup ${src} checks out: ${Object.keys(manifest.files).length} files, `
                    + `${manifest.row_counts.tickets ?? "?"} tickets, aiball ${manifest.aiball_version}, created ${manifest.created_at}\n`
                    + `  nothing was changed (--dry-run)\n`,
                );
                return;
            }
            if (await daemonUp()) {
                // Stopping the daemon cuts loop.sock and every connected loop: the
                // operator does it, knowingly — not a side effect of a restore.
                die(
                    "restore: the daemon is running — stop it first, then restore, then start it:\n"
                    + "    systemctl --user stop aiball\n"
                    + `    aiball restore ${dir}\n`
                    + "    systemctl --user start aiball\n"
                    + "  Stopping it disconnects every running loop.",
                );
            }
            const r = applyRestore({ ...(await paths()), src, manifest });
            if (json) {
                jsonline({ ok: true, set_aside: r.setAside, manifest });
                return;
            }
            process.stdout.write(
                `restored ${src}: ${manifest.row_counts.tickets ?? "?"} tickets, created ${manifest.created_at}\n`
                + (r.setAside.home ? `  previous data set aside: ${r.setAside.home}\n` : "")
                + (r.setAside.config ? `  previous config set aside: ${r.setAside.config}\n` : "")
                + `  start the daemon: systemctl --user start aiball (an older schema migrates at start)\n`,
            );
        });
}
