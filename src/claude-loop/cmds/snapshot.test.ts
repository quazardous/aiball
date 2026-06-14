// #963 — snapshot tool tests : capture / list / prune sous tmpdir.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    captureSnapshot,
    isoDirname,
    listSnapshots,
    parseTimespec,
    pruneSnapshots,
} from "./snapshot.js";

function mkSd(): string {
    return mkdtempSync(join(tmpdir(), "snap-"));
}

function seedStateDir(sd: string): void {
    writeFileSync(join(sd, "loop.log"), "boot\nstop\n");
    writeFileSync(join(sd, "stop-hook.log"), "hook\n");
    writeFileSync(join(sd, "afk.log"), "afk\n");
    mkdirSync(join(sd, "pane-captures"));
    writeFileSync(join(sd, "pane-captures", "2026-06-14T10-00-00Z.txt"), "frame1");
    writeFileSync(join(sd, "pane-captures", "2026-06-14T10-00-05Z.txt"), "frame2");
}

test("isoDirname: produces YYYY-MM-DDTHH-MM-SS (filesystem-safe)", () => {
    const ts = Date.parse("2026-06-14T11:08:30.456Z");
    assert.equal(isoDirname(ts), "2026-06-14T11-08-30");
});

test("parseTimespec: 7d / 12h / 2w / 30m / 45s", () => {
    assert.equal(parseTimespec("7d"), 7 * 86_400_000);
    assert.equal(parseTimespec("12h"), 12 * 3_600_000);
    assert.equal(parseTimespec("2w"), 2 * 7 * 86_400_000);
    assert.equal(parseTimespec("30m"), 30 * 60_000);
    assert.equal(parseTimespec("45s"), 45_000);
});

test("parseTimespec: bad input throws", () => {
    assert.throws(() => parseTimespec("7"), /bad timespec/);
    assert.throws(() => parseTimespec("foo"), /bad timespec/);
});

test("captureSnapshot: copies known files + pane-captures into <sd>/snapshots/<iso>/", () => {
    const sd = mkSd();
    seedStateDir(sd);
    const dir = captureSnapshot(sd, { nowMs: Date.parse("2026-06-14T11:08:30Z") });
    assert.equal(dir, join(sd, "snapshots", "2026-06-14T11-08-30"));
    assert.equal(readFileSync(join(dir, "loop.log"), "utf8"), "boot\nstop\n");
    assert.equal(readFileSync(join(dir, "stop-hook.log"), "utf8"), "hook\n");
    assert.equal(readFileSync(join(dir, "afk.log"), "utf8"), "afk\n");
    assert.equal(readFileSync(join(dir, "pane-captures", "2026-06-14T10-00-00Z.txt"), "utf8"), "frame1");
    assert.equal(readFileSync(join(dir, "pane-captures", "2026-06-14T10-00-05Z.txt"), "utf8"), "frame2");
    rmSync(sd, { recursive: true, force: true });
});

test("captureSnapshot: tolerates a partial sd (missing files silently skipped)", () => {
    const sd = mkSd();
    writeFileSync(join(sd, "loop.log"), "only this\n");
    const dir = captureSnapshot(sd, { nowMs: Date.parse("2026-06-14T11:08:30Z") });
    assert.ok(existsSync(join(dir, "loop.log")));
    assert.ok(!existsSync(join(dir, "stop-hook.log")));
    assert.ok(!existsSync(join(dir, "pane-captures")));
    rmSync(sd, { recursive: true, force: true });
});

test("captureSnapshot: --note writes note.txt", () => {
    const sd = mkSd();
    seedStateDir(sd);
    const dir = captureSnapshot(sd, { nowMs: Date.parse("2026-06-14T11:08:30Z"), note: "bug #960 fall at 11:08:05" });
    assert.equal(readFileSync(join(dir, "note.txt"), "utf8"), "bug #960 fall at 11:08:05\n");
    rmSync(sd, { recursive: true, force: true });
});

test("captureSnapshot: sub-second collision → suffix _2, _3...", () => {
    const sd = mkSd();
    seedStateDir(sd);
    const t = Date.parse("2026-06-14T11:08:30Z");
    const d1 = captureSnapshot(sd, { nowMs: t });
    const d2 = captureSnapshot(sd, { nowMs: t });
    const d3 = captureSnapshot(sd, { nowMs: t });
    assert.equal(d1, join(sd, "snapshots", "2026-06-14T11-08-30"));
    assert.equal(d2, join(sd, "snapshots", "2026-06-14T11-08-30_2"));
    assert.equal(d3, join(sd, "snapshots", "2026-06-14T11-08-30_3"));
    rmSync(sd, { recursive: true, force: true });
});

test("listSnapshots: empty dir → []", () => {
    const sd = mkSd();
    assert.deepEqual(listSnapshots(sd), []);
    rmSync(sd, { recursive: true, force: true });
});

test("listSnapshots: tri desc par mtime + bytes calculés + note récupérée", () => {
    const sd = mkSd();
    seedStateDir(sd);
    captureSnapshot(sd, { nowMs: Date.parse("2026-06-14T10:00:00Z") });
    const d2 = captureSnapshot(sd, { nowMs: Date.parse("2026-06-14T11:00:00Z"), note: "second snap" });
    captureSnapshot(sd, { nowMs: Date.parse("2026-06-14T09:00:00Z") });
    // Manually shift mtimes so the test is deterministic regardless of fs precision.
    utimesSync(join(sd, "snapshots", "2026-06-14T10-00-00"), 1700, 1700);
    utimesSync(join(sd, "snapshots", "2026-06-14T11-00-00"), 1800, 1800);
    utimesSync(join(sd, "snapshots", "2026-06-14T09-00-00"), 1600, 1600);
    const snaps = listSnapshots(sd);
    assert.equal(snaps.length, 3);
    assert.equal(snaps[0]?.name, "2026-06-14T11-00-00");
    assert.equal(snaps[0]?.note, "second snap");
    assert.equal(snaps[0]?.path, d2);
    assert.equal(snaps[1]?.name, "2026-06-14T10-00-00");
    assert.equal(snaps[1]?.note, null);
    assert.equal(snaps[2]?.name, "2026-06-14T09-00-00");
    assert.ok((snaps[0]?.bytes ?? 0) > 0, "size should be positive");
    rmSync(sd, { recursive: true, force: true });
});

test("pruneSnapshots: --keep N retains the N newest", () => {
    const sd = mkSd();
    seedStateDir(sd);
    for (const iso of ["2026-06-14T09:00:00Z", "2026-06-14T10:00:00Z", "2026-06-14T11:00:00Z", "2026-06-14T12:00:00Z", "2026-06-14T13:00:00Z"]) {
        captureSnapshot(sd, { nowMs: Date.parse(iso) });
    }
    // align mtimes with names so the test is deterministic.
    utimesSync(join(sd, "snapshots", "2026-06-14T09-00-00"), 900, 900);
    utimesSync(join(sd, "snapshots", "2026-06-14T10-00-00"), 1000, 1000);
    utimesSync(join(sd, "snapshots", "2026-06-14T11-00-00"), 1100, 1100);
    utimesSync(join(sd, "snapshots", "2026-06-14T12-00-00"), 1200, 1200);
    utimesSync(join(sd, "snapshots", "2026-06-14T13-00-00"), 1300, 1300);
    const victims = pruneSnapshots(sd, { keep: 2, nowMs: 1_700_000_000 });
    const names = victims.map((v) => v.name).sort();
    assert.deepEqual(names, [
        "2026-06-14T09-00-00",
        "2026-06-14T10-00-00",
        "2026-06-14T11-00-00",
    ]);
    rmSync(sd, { recursive: true, force: true });
});

test("pruneSnapshots: --older Nd cuts those whose mtime is older than nowMs - Nd", () => {
    const sd = mkSd();
    seedStateDir(sd);
    captureSnapshot(sd, { nowMs: Date.parse("2026-06-14T11:00:00Z") });
    captureSnapshot(sd, { nowMs: Date.parse("2026-06-07T11:00:00Z") });
    // age the older snapshot's mtime so the prune trips on it.
    const tooOld = new Date("2026-06-01T00:00:00Z").getTime() / 1000;
    utimesSync(join(sd, "snapshots", "2026-06-07T11-00-00"), tooOld, tooOld);
    const recent = new Date("2026-06-14T11:00:00Z").getTime() / 1000;
    utimesSync(join(sd, "snapshots", "2026-06-14T11-00-00"), recent, recent);
    const now = Date.parse("2026-06-14T12:00:00Z");
    const victims = pruneSnapshots(sd, { olderMs: parseTimespec("7d"), nowMs: now });
    const names = victims.map((v) => v.name);
    assert.deepEqual(names, ["2026-06-07T11-00-00"]);
    rmSync(sd, { recursive: true, force: true });
});

test("pruneSnapshots: --all returns every snapshot (caller decides to delete)", () => {
    const sd = mkSd();
    seedStateDir(sd);
    captureSnapshot(sd, { nowMs: Date.parse("2026-06-14T11:00:00Z") });
    captureSnapshot(sd, { nowMs: Date.parse("2026-06-14T12:00:00Z") });
    const victims = pruneSnapshots(sd, { all: true, nowMs: Date.parse("2026-06-14T13:00:00Z") });
    assert.equal(victims.length, 2);
    rmSync(sd, { recursive: true, force: true });
});

test("pruneSnapshots: --keep 10 default keeps everyone if fewer than 10", () => {
    const sd = mkSd();
    seedStateDir(sd);
    captureSnapshot(sd, { nowMs: Date.parse("2026-06-14T11:00:00Z") });
    const victims = pruneSnapshots(sd, { nowMs: Date.parse("2026-06-14T12:00:00Z") }); // no keep override
    assert.equal(victims.length, 0);
    rmSync(sd, { recursive: true, force: true });
});
