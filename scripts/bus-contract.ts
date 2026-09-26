/**
 * #3069 — write the bus's published contract, generated from the code:
 *   docs/api-bus.openrpc.json   the methods (OpenRPC)
 *   docs/api-bus.asyncapi.json  the subjects (AsyncAPI)
 * `npx tsx scripts/bus-contract.ts` writes them; `--check` exits 1 when they
 * are stale (the test in src/bus/contract.test.ts does the same).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { asyncApiDocument, openRpcDocument } from "../src/bus/contract.js";

const ROOT = resolve(import.meta.dirname, "..");
const FILES = [
    [resolve(ROOT, "docs", "api-bus.openrpc.json"), () => openRpcDocument()],
    [resolve(ROOT, "docs", "api-bus.asyncapi.json"), () => asyncApiDocument()],
] as const;

const check = process.argv.includes("--check");
let stale = 0;
for (const [path, build] of FILES) {
    const text = `${JSON.stringify(build(), null, 2)}\n`;
    let current = "";
    try { current = readFileSync(path, "utf8"); } catch { /* not written yet */ }
    if (current === text) continue;
    if (check) {
        console.error(`stale: ${path}`);
        stale++;
    } else {
        writeFileSync(path, text);
        console.log(`wrote ${path}`);
    }
}
process.exit(stale ? 1 : 0);
