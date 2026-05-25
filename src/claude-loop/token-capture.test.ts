import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    projectTranscriptDir,
    latestSessionFile,
    latestTurnUsage,
    captureTokenUsage,
    activeTicketMarkerPath,
    type TurnUsage,
} from "./token-capture.js";

function tmp(): string {
    return mkdtempSync(join(tmpdir(), "cl-tokcap-"));
}
function turn(id: string, usage: Record<string, number>): string {
    return JSON.stringify({ message: { role: "assistant", id, usage } });
}

test("#404 projectTranscriptDir: encodes / and . to -", () => {
    const d = projectTranscriptDir("/home/x/Private/dev/a.b");
    assert.ok(d.endsWith("-home-x-Private-dev-a-b"), d);
});

test("#404 latestSessionFile: newest .jsonl by mtime", () => {
    const dir = tmp();
    try {
        writeFileSync(join(dir, "old.jsonl"), "");
        writeFileSync(join(dir, "new.jsonl"), "");
        utimesSync(join(dir, "old.jsonl"), new Date(1000), new Date(1000));
        utimesSync(join(dir, "new.jsonl"), new Date(9000), new Date(9000));
        writeFileSync(join(dir, "note.txt"), ""); // ignored (not .jsonl)
        assert.equal(latestSessionFile(dir), join(dir, "new.jsonl"));
        assert.equal(latestSessionFile(join(dir, "nope")), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#404 latestTurnUsage: returns the LAST assistant turn with usage", () => {
    const dir = tmp();
    try {
        const f = join(dir, "s.jsonl");
        writeFileSync(f, [
            turn("msg_1", { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 }),
            JSON.stringify({ message: { role: "user", id: "u1" } }), // skipped (not assistant)
            "garbage line",                                          // skipped (unparseable)
            turn("msg_2", { input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 99 }),
            "",
        ].join("\n"));
        const u = latestTurnUsage(f);
        assert.deepEqual(u, { id: "msg_2", in: 20, out: 5, cacheW: 0, cacheR: 99 });
        assert.equal(latestTurnUsage(join(dir, "missing.jsonl")), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#404 captureTokenUsage: pushes the turn to the marked ticket, then dedups", async () => {
    const tdir = tmp(); const sdir = tmp();
    try {
        writeFileSync(join(tdir, "s.jsonl"), turn("msg_42", { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 1, cache_read_input_tokens: 4 }));
        writeFileSync(activeTicketMarkerPath(sdir), "404");
        const pushed: Array<{ id: number; u: TurnUsage }> = [];
        const opts = { transcriptDir: tdir, stateDir: sdir, postUsage: (id: number, u: TurnUsage) => { pushed.push({ id, u }); } };

        const r1 = await captureTokenUsage(opts);
        assert.equal(pushed.length, 1);
        assert.equal(pushed[0].id, 404);
        assert.deepEqual(pushed[0].u, { id: "msg_42", in: 7, out: 3, cacheW: 1, cacheR: 4 });
        assert.deepEqual(r1, { status: "pushed", ticketId: 404, turn: { id: "msg_42", in: 7, out: 3, cacheW: 1, cacheR: 4 } });

        const r2 = await captureTokenUsage(opts); // same turn id → deduped, no second push
        assert.equal(pushed.length, 1);
        assert.deepEqual(r2, { status: "deduped", id: "msg_42" });
    } finally { rmSync(tdir, { recursive: true, force: true }); rmSync(sdir, { recursive: true, force: true }); }
});

test("#446 captureTokenUsage: targetTicketId overrides the active-ticket marker", async () => {
    const tdir = tmp(); const sdir = tmp();
    try {
        writeFileSync(join(tdir, "s.jsonl"), turn("msg_77", { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 1, cache_read_input_tokens: 9 }));
        writeFileSync(activeTicketMarkerPath(sdir), "100"); // marker says ticket 100
        const pushed: Array<{ id: number; u: TurnUsage }> = [];
        const opts = { transcriptDir: tdir, stateDir: sdir, targetTicketId: 200, postUsage: (id: number, u: TurnUsage) => { pushed.push({ id, u }); } };

        const r = await captureTokenUsage(opts);
        // attributed to the explicit target (200), NOT the marker (100)
        assert.equal(pushed.length, 1);
        assert.equal(pushed[0].id, 200);
        assert.deepEqual(r, { status: "pushed", ticketId: 200, turn: { id: "msg_77", in: 5, out: 2, cacheW: 1, cacheR: 9 } });
        // dedup claimed → a second drain (e.g. the Stop-hook) of the same turn is a no-op
        const r2 = await captureTokenUsage({ transcriptDir: tdir, stateDir: sdir, postUsage: () => { throw new Error("must not push"); } });
        assert.deepEqual(r2, { status: "deduped", id: "msg_77" });
        assert.equal(pushed.length, 1);
    } finally { rmSync(tdir, { recursive: true, force: true }); rmSync(sdir, { recursive: true, force: true }); }
});

test("#404 captureTokenUsage: no marker → no push, but still records the id (no re-scan)", async () => {
    const tdir = tmp(); const sdir = tmp();
    try {
        writeFileSync(join(tdir, "s.jsonl"), turn("msg_9", { input_tokens: 1, output_tokens: 1 }));
        let pushes = 0;
        const r = await captureTokenUsage({ transcriptDir: tdir, stateDir: sdir, postUsage: () => { pushes++; } });
        assert.equal(pushes, 0); // no active-ticket marker
        assert.deepEqual(r, { status: "no-marker", id: "msg_9" });
        assert.ok(existsSync(join(sdir, "token-push-last-id")));
        assert.equal(readFileSync(join(sdir, "token-push-last-id"), "utf8"), "msg_9");
    } finally { rmSync(tdir, { recursive: true, force: true }); rmSync(sdir, { recursive: true, force: true }); }
});

test("#404 captureTokenUsage: no transcript dir → no-file (the #404 bug surface)", async () => {
    const sdir = tmp();
    try {
        const r = await captureTokenUsage({ transcriptDir: join(sdir, "nope"), stateDir: sdir, postUsage: () => { /* unused */ } });
        assert.deepEqual(r, { status: "no-file" });
    } finally { rmSync(sdir, { recursive: true, force: true }); }
});

test("#404 captureTokenUsage: transcript without usage → no-turn", async () => {
    const tdir = tmp(); const sdir = tmp();
    try {
        writeFileSync(join(tdir, "s.jsonl"), JSON.stringify({ message: { role: "user", id: "u1" } }));
        const r = await captureTokenUsage({ transcriptDir: tdir, stateDir: sdir, postUsage: () => { /* unused */ } });
        assert.deepEqual(r, { status: "no-turn" });
    } finally { rmSync(tdir, { recursive: true, force: true }); rmSync(sdir, { recursive: true, force: true }); }
});

test("#404 captureTokenUsage: marker ok but POST throws → push-failed (id still recorded)", async () => {
    const tdir = tmp(); const sdir = tmp();
    try {
        writeFileSync(join(tdir, "s.jsonl"), turn("msg_x", { input_tokens: 1, output_tokens: 1 }));
        writeFileSync(activeTicketMarkerPath(sdir), "404");
        const r = await captureTokenUsage({ transcriptDir: tdir, stateDir: sdir, postUsage: () => { throw new Error("boom"); } });
        assert.deepEqual(r, { status: "push-failed", ticketId: 404, id: "msg_x" });
        assert.equal(readFileSync(join(sdir, "token-push-last-id"), "utf8"), "msg_x");
    } finally { rmSync(tdir, { recursive: true, force: true }); rmSync(sdir, { recursive: true, force: true }); }
});
