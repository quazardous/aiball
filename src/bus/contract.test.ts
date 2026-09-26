/**
 * #3069 — the published contract: the documents in docs/ are the ones the code
 * produces; every method and subject says what it is; `rpc.discover` serves the
 * same document; and every method and subject tvty's code names exists (read
 * from tvty's checkout next door, or AIBALL_TVTY_DIR; skipped without it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3069-"));
process.env.AIBALL_SOCK = "";

const { asyncApiDocument, openRpcDocument } = await import("./contract.js");
const { getMethod } = await import("./methods.js");
const { walk } = await import("../devtools/route-inventory-lib.js");

const ROOT = resolve(import.meta.dirname, "..", "..");
const text = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

test("docs/api-bus.openrpc.json and docs/api-bus.asyncapi.json are what the code produces", () => {
    for (const [file, doc] of [["api-bus.openrpc.json", openRpcDocument()], ["api-bus.asyncapi.json", asyncApiDocument()]] as const) {
        const written = readFileSync(join(ROOT, "docs", file), "utf8");
        assert.equal(written, text(doc), `docs/${file} is stale: npx tsx scripts/bus-contract.ts`);
    }
});

test("every method and every subject says what it is", () => {
    const rpc = openRpcDocument() as { methods: { name: string; description: string }[] };
    assert.deepEqual(rpc.methods.filter((m) => !m.description).map((m) => m.name), []);
    const api = asyncApiDocument() as { channels: Record<string, { messages: { value: { summary: string }; event: { summary: string } } }> };
    assert.deepEqual(Object.entries(api.channels).filter(([, c]) => !c.messages.value.summary || !c.messages.event.summary).map(([k]) => k), []);
});

test("rpc.discover serves the document the code produces", async () => {
    const out = await getMethod("rpc.discover")!.run({ consumer_id: "x", kind: "agent", relayed: false } as never, {});
    assert.deepEqual(out, openRpcDocument());
});

const tvtyDir = process.env.AIBALL_TVTY_DIR ?? join(ROOT, "..", "tvty");
const hasTvty = existsSync(join(tvtyDir, "src"));

test("every method and subject tvty's code names is in the contract", { skip: hasTvty ? false : `no tvty checkout at ${tvtyDir}` }, () => {
    const rpc = openRpcDocument() as { methods: { name: string }[] };
    const methods = new Set(rpc.methods.map((m) => m.name));
    const patterns = Object.keys((asyncApiDocument() as { channels: Record<string, unknown> }).channels).map((p) => p.split("."));
    const isSubject = (s: string) => {
        const parts = s.replace(/\{[^}]*\}/g, "x").split(".");
        return patterns.some((p) => p.length === parts.length && p.every((seg, i) => seg === "*" || seg === parts[i]));
    };
    const notifications = new Set(["bus.hello", "bus.event"]);
    const nouns = /^(bus|rpc|inbox|ticket|message|consumer|tag|project|mention|session|agent|user)\./;
    const unknown = new Set<string>();
    for (const f of walk(join(tvtyDir, "src"), (p) => p.endsWith(".rs"))) {
        for (const m of readFileSync(f, "utf8").matchAll(/"([a-z_]+\.[a-z0-9_.*{}-]+)"/g)) {
            const s = m[1];
            if (!nouns.test(s) || notifications.has(s) || methods.has(s) || isSubject(s)) continue;
            unknown.add(s);
        }
    }
    assert.deepEqual([...unknown].sort(), [], "names tvty uses that the contract does not have");
});
