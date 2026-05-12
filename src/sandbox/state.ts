/**
 * Sandbox state shared by the CLI (`bin/claude-sandbox`) and the two hooks
 * (SessionStart, Stop). Layout under $STATE_ROOT/<NAME>/:
 *
 *   plate.json        — list of tickets the sandbox is working on + halt flag
 *   env               — sourceable shell file with AIBALL_* + SB_* vars
 *   hooks/            — copies of the thin bash hook wrappers
 *   last-block.json   — anti-oscillation marker, written by stop hook
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export type TicketLocalStatus = "open" | "closed" | "escalated" | "rejected";

export interface PlateTicket {
    id: number;
    status: TicketLocalStatus;
}

export type SandboxMode = "in-place" | "worktree";

export interface Plate {
    agent: string;
    name: string;
    mode: SandboxMode;
    dir: string;
    project: string;
    tickets: PlateTicket[];
    halt: boolean;
}

export interface LastBlock {
    plate_fp: string;
    blocked_ticket_id: number;
}

export const STATE_ROOT =
    process.env.CLAUDE_SANDBOX_STATE ?? join(homedir(), ".aiball-sandbox");

export const WORKTREE_ROOT =
    process.env.CLAUDE_SANDBOX_WORKTREES ?? join(homedir(), "sandboxes");

export function stateDirFor(name: string): string {
    return join(STATE_ROOT, name);
}

export function platePath(stateDir: string): string {
    return join(stateDir, "plate.json");
}

export function envPath(stateDir: string): string {
    return join(stateDir, "env");
}

export function lastBlockPath(stateDir: string): string {
    return join(stateDir, "last-block.json");
}

export function readPlate(stateDir: string): Plate {
    return JSON.parse(readFileSync(platePath(stateDir), "utf8")) as Plate;
}

/** Atomic write via tmp + rename so a crashed write can't leave a half file. */
export function writePlate(stateDir: string, plate: Plate): void {
    const final = platePath(stateDir);
    const tmp = `${final}.tmp`;
    writeFileSync(tmp, JSON.stringify(plate, null, 2) + "\n");
    renameSync(tmp, final);
}

export function plateFingerprint(plate: Plate): string {
    // Mirror what the doc says: tickets array + halt flag. Anything else
    // (project, dir, agent) shouldn't influence the oscillation check.
    const canonical = JSON.stringify({
        tickets: plate.tickets,
        halt: plate.halt,
    });
    return createHash("sha256").update(canonical).digest("hex");
}

export function readLastBlock(stateDir: string): LastBlock | null {
    const p = lastBlockPath(stateDir);
    if (!existsSync(p)) return null;
    try {
        return JSON.parse(readFileSync(p, "utf8")) as LastBlock;
    } catch {
        return null;
    }
}

export function writeLastBlock(stateDir: string, lb: LastBlock | null): void {
    const p = lastBlockPath(stateDir);
    if (lb === null) {
        // Delete the marker; missing file = "no prior block".
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require("node:fs").unlinkSync(p);
        } catch {
            /* already gone */
        }
        return;
    }
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(lb, null, 2) + "\n");
    renameSync(tmp, p);
}

export function ensureDir(path: string): void {
    mkdirSync(path, { recursive: true });
}
