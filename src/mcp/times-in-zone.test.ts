/**
 * #3969 — what an MCP tool returns carries its times in the board's zone, with
 * the offset. No daemon here: the zone falls back to this machine's, pinned by
 * TZ, which is what `auto` means.
 */
process.env.TZ = "Europe/Paris";
process.env.AIBALL_SOCK = "";
import { test } from "node:test";
import assert from "node:assert/strict";
const { asText } = await import("./_helpers.js");

test("a tool's UTC times come back in the zone, with the offset", async () => {
    const r = await asText({ ticket: { id: 7, created_at: "2026-10-13T10:44:47.774Z", title: "x" } });
    const out = JSON.parse(r.content[0].text) as { ticket: { created_at: string; title: string } };
    assert.equal(out.ticket.created_at, "2026-10-13T12:44:47.774+02:00");
    assert.equal(out.ticket.title, "x");
});
