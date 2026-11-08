/**
 * #4794 — an MCP server that outlives an update of its own tools says so.
 *
 * Claude Code starts this server once per session and keeps it: a deploy does
 * not reach it, so its schemas stay the ones it was started with. A field added
 * since is stripped before it is sent, with no refusal anywhere (the plan
 * options' `confidence` was, for every session started before it). The server
 * remembers what its tools were made of when it started and, when those files
 * change on disk, every answer carries `_status.stale_tools`: the agent reads
 * it on its next call and can ask the human for `/mcp` or a loop restart.
 *
 * What the tools are made of: the MCP server's own files and the few modules
 * whose values its schemas use. A deploy that leaves them alone says nothing.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The install root: this file is `<root>/src/mcp/stale-tools.ts`. */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The files a tool's schema or description comes from, relative to the root. */
export const TOOL_SOURCES = ["src/mcp.ts", "src/mcp", "src/client.ts", "src/decisions.ts"];

/** How long a signature read stays good: a disk read per tool call is not worth it. */
const RECHECK_MS = 30_000;

function sourceFiles(root: string): string[] {
    const files: string[] = [];
    for (const rel of TOOL_SOURCES) {
        const path = join(root, rel);
        if (!existsSync(path)) continue;
        if (statSync(path).isDirectory()) {
            for (const name of readdirSync(path).sort()) {
                if (name.endsWith(".ts") && !name.endsWith(".test.ts")) files.push(join(rel, name));
            }
        } else {
            files.push(rel);
        }
    }
    return files;
}

/** The tools' sources as they are on disk now: one hash over their names and contents. */
export function toolsSignature(root = ROOT): string {
    const hash = createHash("sha1");
    for (const rel of sourceFiles(root)) {
        hash.update(rel).update("\0");
        try { hash.update(readFileSync(join(root, rel))); } catch { hash.update("missing"); }
        hash.update("\0");
    }
    return hash.digest("hex").slice(0, 12);
}

export interface StaleTools {
    /** The sentence for the agent, or null while the tools are the ones on disk. */
    check(nowMs?: number): string | null;
}

/** A watcher started now: what it reads at once is what this server's tools are. */
export function watchTools(root = ROOT, recheckMs = RECHECK_MS): StaleTools {
    const startedAt = new Date();
    let loaded: string;
    try { loaded = toolsSignature(root); } catch { return { check: () => null }; }
    let readAt = -Infinity;
    let stale: string | null = null;
    return {
        check(nowMs = Date.now()) {
            if (stale !== null || nowMs - readAt < recheckMs) return stale;
            readAt = nowMs;
            let now: string;
            try { now = toolsSignature(root); } catch { return null; }
            if (now !== loaded) {
                stale = `aiball's tools changed on disk since this session loaded them (${startedAt.toISOString()}): `
                    + "a field or a tool added since is not known here, and a field it does not know is dropped before it is sent. "
                    + "Ask the human for a claude-loop restart (it reloads the tools and their descriptions), or at least /mcp (reconnect aiball: the new code, the old descriptions).";
            }
            return stale;
        },
    };
}

/** The watcher of this process, started when the MCP server loads its tools. */
export const staleTools = watchTools();
