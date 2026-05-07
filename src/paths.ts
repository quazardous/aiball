import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const AIBALL_HOME =
    process.env.AIBALL_HOME ?? join(homedir(), ".local", "share", "aiball");

export const DB_PATH = join(AIBALL_HOME, "aiball.db");
export const OUTBOX_DIR = join(AIBALL_HOME, "outbox");
export const SPOOL_DIR = join(AIBALL_HOME, "spool");
export const SPOOL_FAILED_DIR = join(AIBALL_HOME, "spool", "failed");

export function ensureDirs(): void {
    mkdirSync(AIBALL_HOME, { recursive: true });
    mkdirSync(OUTBOX_DIR, { recursive: true });
    mkdirSync(SPOOL_DIR, { recursive: true });
    mkdirSync(SPOOL_FAILED_DIR, { recursive: true });
}

export function outboxPath(project: string): string {
    if (!/^[a-zA-Z0-9_.-]+$/.test(project)) {
        throw new Error(`invalid project name: ${project}`);
    }
    return join(OUTBOX_DIR, `${project}.jsonl`);
}
