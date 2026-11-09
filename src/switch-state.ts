/**
 * #4868 — a master handing the board over to a node: while it does, it takes
 * no write. A write is refused (503 `SWITCHING`) and its client queues it, as
 * during a cut; on the new master's side it is replayed. Reads still answer,
 * and so do the replica's own calls and the machine's methods.
 *
 * Kept on disk (`$AIBALL_HOME/switching.json`): a master that restarts in the
 * middle of a switch is still switching, until the switch commits or aborts.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIBALL_HOME } from "./paths.js";
import { BOARD_READS } from "./replica-reads.js";
import { loadProxy } from "./proxy.js";

export interface Switching {
    /** The node taking the board over, as its token's label names it. */
    to: string;
    since: string;
    /** The board's last revision when the master stopped taking writes. */
    last: number;
}

const FILE = () => join(AIBALL_HOME, "switching.json");
let cached: Switching | null | undefined;

export function switching(): Switching | null {
    if (cached !== undefined) return cached;
    try { cached = existsSync(FILE()) ? (JSON.parse(readFileSync(FILE(), "utf8")) as Switching) : null; } catch { cached = null; }
    return cached;
}

export function beginSwitching(s: Switching): void {
    writeFileSync(FILE(), JSON.stringify(s));
    cached = s;
}

export function endSwitching(): void {
    rmSync(FILE(), { force: true });
    cached = null;
}

/**
 * Whether `method` waits while the board is handed over: a write does; a read,
 * a replica call or a machine method does not.
 */
export function waitsForSwitch(method: string, machine: boolean): boolean {
    if (!switching()) return false;
    return !(BOARD_READS.has(method) || method.startsWith("replica.") || machine);
}

let isNode: boolean | undefined;

/**
 * #4868 — whether the board's own periodic writes run here: on its master, and
 * not while it hands the board over. A proxy node's copy is the master's
 * (it would diverge), and a switching master takes no write.
 */
export function boardWritesHere(): boolean {
    isNode ??= loadProxy() !== null;
    return !isNode && !switching();
}
