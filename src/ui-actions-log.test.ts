// #4090 — the human's UI actions: one compact line per call, identifiers only, kept for a while.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-4090-"));
process.env.AIBALL_SOCK = "";

const { getDb } = await import("./db/connection.js");
const { setConfigOverride } = await import("./db/config-overrides.js");
const { housekeep, recordUiAction, resetUiActionsDayForTests, uiActionLine, UI_ACTIONS_RETENTION_KEY } = await import("./ui-actions-log.js");
getDb();

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

const AT = Date.parse("2026-10-17T09:14:25.655Z");
const human = { kind: "human", consumer_id: "david", platform: "web" };

test("a human's call is one line: time, who, client, method, project, ticket — never a text", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-a-"));
    resetUiActionsDayForTests();
    recordUiAction(human, "message.post", { project: "aiball", ticket_id: 4088, body: "a secret thought\twith a tab" }, AT, dir);
    const text = readFileSync(join(dir, "2026-10-17.tsv"), "utf8");
    assert.equal(text, "09:14:25.655\tdavid\tweb\tmessage.post\taiball\t4088\n");
    assert.doesNotMatch(text, /secret/);
});

test("an agent's call is not kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-b-"));
    resetUiActionsDayForTests();
    recordUiAction({ kind: "agent", consumer_id: "helios-claude" }, "ticket.get", { id: 1 }, AT, dir);
    assert.equal(existsSync(join(dir, "2026-10-17.tsv")), false);
});

test("a line stays compact, and a tab or newline in a value cannot split it", () => {
    const line = uiActionLine(AT, "da\tvid", "tvty", "ticket.get", { project: "a\nb", id: 7 });
    assert.equal(line.split("\t").length, 6);
    assert.equal(line.split("\n").length, 2);
    assert.ok(line.length < 80);
});

test("past days are gzipped, days past the retention deleted", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-c-"));
    writeFileSync(join(dir, "2026-10-16.tsv"), "x\n");
    writeFileSync(join(dir, "2026-01-01.tsv.gz"), "old");
    writeFileSync(join(dir, "2026-10-17.tsv"), "today\n");
    housekeep(dir, "2026-10-17", 180 * 86_400, AT);
    assert.deepEqual(readdirSync(dir).sort(), ["2026-10-16.tsv.gz", "2026-10-17.tsv"]);
    assert.equal(gunzipSync(readFileSync(join(dir, "2026-10-16.tsv.gz"))).toString(), "x\n");
});

test("a retention of 0 keeps nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-d-"));
    setConfigOverride("", UI_ACTIONS_RETENTION_KEY, 0);
    resetUiActionsDayForTests();
    recordUiAction(human, "ticket.get", { id: 1 }, AT, dir);
    assert.equal(existsSync(join(dir, "2026-10-17.tsv")), false);
});
