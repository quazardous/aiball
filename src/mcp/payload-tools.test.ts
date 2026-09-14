/**
 * #2454 — the MCP payload tools, driven with the client stubbed. What must hold:
 * - `payload_set` reads the file on this host and sends its object, with the
 *   public keys; no value appears in the tool's answer;
 * - `payload_dump` writes the values into a file and answers with the path and
 *   the key names only — merging into an existing env file;
 * - a malformed deposit file fails without its content in the error.
 * The access rule (reporter, assignee, human; not a claimant) is the daemon's,
 * held by db/ticket-payload.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2454-mcp-"));
process.env.AIBALL_SOCK = "";
const { CL_ENV } = await import("../claude-loop/env-vars.js");
delete process.env[CL_ENV.STATE_DIR];

const { client } = await import("./_helpers.js");
const { registerPayloadTools } = await import("./payload.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const handlers: Record<string, Handler> = {};
registerPayloadTools({
    registerTool: (name: string, _config: unknown, handler: Handler) => { handlers[name] = handler; },
} as never);

const SECRET = "sk-live-THIS-MUST-NEVER-SHOW";
const dir = mkdtempSync(join(tmpdir(), "payload-tools-"));
const stub = client as unknown as Record<string, unknown>;
const deposited: { ticketId: number; payload: Record<string, unknown>; publicKeys: string[] }[] = [];
stub.setTicketPayload = async (ticketId: number, payload: Record<string, unknown>, publicKeys: string[]) => {
    deposited.push({ ticketId, payload, publicKeys });
    return { ticket_id: ticketId, keys: Object.keys(payload), payload: { api_key: { secret: true, preview: "sk-l" }, endpoint: "https://x" } };
};
stub.dumpTicketPayload = async () => ({ payload: { BMS_M2M_IMAGE_KEY: SECRET } });

test("payload_set reads the file and sends its object; the answer carries no value", async () => {
    const file = join(dir, "handover.json");
    writeFileSync(file, JSON.stringify({ api_key: SECRET, endpoint: "https://x" }));
    const out = await handlers.payload_set({ ticket_id: 2452, from_file: file, public: ["endpoint"] });
    assert.deepEqual(deposited.at(-1), { ticketId: 2452, payload: { api_key: SECRET, endpoint: "https://x" }, publicKeys: ["endpoint"] });
    assert.ok(!out.content[0].text.includes(SECRET), "the secret is not in the tool answer");
});

test("payload_dump merges into an existing env file and answers with names only", async () => {
    const env = join(dir, ".env.local");
    writeFileSync(env, "ENGINE_KEY=keep-me\n");
    const out = await handlers.payload_dump({ ticket_id: 2452, to_file: env, format: "env" });
    assert.equal(readFileSync(env, "utf8"), `ENGINE_KEY=keep-me\nBMS_M2M_IMAGE_KEY=${SECRET}\n`);
    const text = out.content[0].text;
    assert.ok(!text.includes(SECRET), "the secret is not in the tool answer");
    assert.match(text, /BMS_M2M_IMAGE_KEY/);
    assert.match(text, /"merged": true/);
});

test("a malformed deposit file fails without its content in the error", async () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, `{ api_key: ${SECRET} }`);
    await assert.rejects(handlers.payload_set({ ticket_id: 2452, from_file: bad }), (e: Error) => !e.message.includes(SECRET));
});
