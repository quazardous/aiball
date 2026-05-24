import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const AIBALL_HOME =
    process.env.AIBALL_HOME ?? join(homedir(), ".local", "share", "aiball");

export const DB_PATH = join(AIBALL_HOME, "aiball.db");
// #407: the running daemon publishes its pid here so `aiball reload` can send it
// SIGHUP. Under `tsx watch` the daemon runs in a child whose pid changes on every
// code reload, so a stable pidfile is the only reliable handle to the live process.
export const DAEMON_PID_PATH = join(AIBALL_HOME, "daemon.pid");
export const OUTBOX_DIR = join(AIBALL_HOME, "outbox");
export const SPOOL_DIR = join(AIBALL_HOME, "spool");
export const SPOOL_FAILED_DIR = join(AIBALL_HOME, "spool", "failed");
export const UPLOADS_DIR = join(AIBALL_HOME, "uploads");

export function ensureDirs(): void {
    mkdirSync(AIBALL_HOME, { recursive: true });
    mkdirSync(OUTBOX_DIR, { recursive: true });
    mkdirSync(SPOOL_DIR, { recursive: true });
    mkdirSync(SPOOL_FAILED_DIR, { recursive: true });
    mkdirSync(UPLOADS_DIR, { recursive: true });
}

export function outboxPath(project: string): string {
    if (!/^[a-zA-Z0-9_.-]+$/.test(project)) {
        throw new Error(`invalid project name: ${project}`);
    }
    return join(OUTBOX_DIR, `${project}.jsonl`);
}
