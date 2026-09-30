/**
 * #3066 — `claude-loop attach` on a loop that runs on the session host: the
 * detach keys, then a real host — its screen shown, the keys typed reaching
 * the session, the terminal's size followed, and a detach that stops nothing.
 * The host part needs it built (cargo); skipped, and says so, without it.
 */
import { test, after } from "node:test";
import { until } from "../tests/lib.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DetachKeys, attachHost, copyBar } from "./host-attach.js";
import { removeHostHome, sessionHostSkip } from "../tests/session-host-bin.js";

const home = mkdtempSync("/tmp/aiball-3066-attach-");
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
const skip = sessionHostSkip();

const { startHost } = await import("../sessions/hosts.js");
const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
    for (const c of cleanups) await c();
    await removeHostHome(home);
});

test("the detach keys: Ctrl-B D leaves, Ctrl-B Ctrl-B is one Ctrl-B, anything else goes through", () => {
    const k = new DetachKeys();
    assert.deepEqual(k.feed(Buffer.from("ab")), { send: Buffer.from("ab"), detach: false });
    assert.deepEqual(k.feed(Buffer.from("x\x02\x02y")), { send: Buffer.from("x\x02y"), detach: false });
    assert.deepEqual(k.feed(Buffer.from("\x02z")), { send: Buffer.from("\x02z"), detach: false });
    // The prefix may end one read and its key start the next.
    assert.deepEqual(k.feed(Buffer.from("q\x02")), { send: Buffer.from("q"), detach: false });
    assert.equal(k.feed(Buffer.from("D")).detach, true);
    assert.equal(new DetachKeys().feed(Buffer.from("\x02d")).detach, true);
});

test("a real host: the screen shown, keys typed, the size followed, and a detach that stops nothing", { skip }, async () => {
    const link = await startHost({ name: "attach", argv: ["cat"], cwd: home, size: { rows: 20, cols: 70 }, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    cleanups.push(async () => { await link.call("host.shutdown").catch(() => {}); link.close(); });

    const stdin = new PassThrough();
    let shown = "";
    const stdout = Object.assign(new EventEmitter(), {
        columns: 70,
        rows: 20,
        write(chunk: string | Buffer) { shown += chunk.toString(); return true; },
    });
    const ended = attachHost(join(link.info.dir, "attach.sock"), { stdin, stdout: stdout as never });

    await until("attached", async () => ((await link.call("host.hello")) as { clients: number }).clients === 1);
    stdin.write("typed on the host\r");
    await until("the keys echoed back on the screen", () => shown.includes("typed on the host"));
    assert.ok(!shown.includes("COPY"), "with the controls, no copy bar");

    stdout.columns = 100;
    stdout.rows = 30;
    stdout.emit("resize");
    await until("the size followed", async () => {
        const size = ((await link.call("host.hello")) as { size: { rows: number; cols: number } }).size;
        return size.rows === 30 && size.cols === 100;
    });

    stdin.write("\x02d");
    assert.deepEqual(await ended, { reason: "detached" });
    await until("the client gone", async () => ((await link.call("host.hello")) as { clients: number }).clients === 0);
    assert.equal(((await link.call("host.hello")) as { claude: { running: boolean } }).claude.running, true, "the session carries on");
});

test("#3166 — a read-only copy: the screen shown, the keys and the size go nowhere, Ctrl-B D still leaves", { skip }, async () => {
    const link = await startHost({ name: "copy", argv: ["cat"], cwd: home, size: { rows: 20, cols: 70 }, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    cleanups.push(async () => { await link.call("host.shutdown").catch(() => {}); link.close(); });

    const stdin = new PassThrough();
    let shown = "";
    let errors = 0;
    const stdout = Object.assign(new EventEmitter(), {
        columns: 100,
        rows: 30,
        write(chunk: string | Buffer) { shown += chunk.toString(); return true; },
    });
    const ended = attachHost(join(link.info.dir, "attach.sock"), { stdin, stdout: stdout as never }, { readonly: true });
    ended.then((e) => { if (e.reason === "error") errors++; });

    await until("attached", async () => ((await link.call("host.hello")) as { clients: number }).clients === 1);
    stdin.write("not from the copy\r");
    stdout.emit("resize");
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!shown.includes("not from the copy"), "nothing typed reached the session");
    assert.ok(shown.includes("👁 COPY · read-only"), "the copy says so, on its last row");
    assert.ok(shown.includes("\x1b]0;👁 COPY"), "and in the terminal's title");
    const size = ((await link.call("host.hello")) as { size: { rows: number; cols: number } }).size;
    assert.deepEqual([size.rows, size.cols], [20, 70], "the copy does not resize the session");

    stdin.write("\x02d");
    assert.deepEqual(await ended, { reason: "detached" });
    assert.equal(errors, 0);
});

test("#3166 — a read-only copy also leaves on Ctrl-C or Ctrl-D; with the controls, Ctrl-C goes to the session", { skip }, async () => {
    const link = await startHost({ name: "copy-cc", argv: ["bash", "-c", "trap '' INT; exec cat"], cwd: home, size: { rows: 20, cols: 70 }, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    cleanups.push(async () => { await link.call("host.shutdown").catch(() => {}); link.close(); });
    const sock = join(link.info.dir, "attach.sock");
    const term = () => Object.assign(new EventEmitter(), { columns: 70, rows: 20, write() { return true; } });
    for (const key of ["\x03", "\x04"]) {
        const stdin = new PassThrough();
        const ended = attachHost(sock, { stdin, stdout: term() as never }, { readonly: true });
        await until("attached", async () => ((await link.call("host.hello")) as { clients: number }).clients === 1);
        stdin.write(key);
        assert.deepEqual(await ended, { reason: "detached" }, JSON.stringify(key));
        await until("the client gone", async () => ((await link.call("host.hello")) as { clients: number }).clients === 0);
    }
    // With the controls, Ctrl-C is the session's: the attach stays.
    const stdin = new PassThrough();
    let over = false;
    const ended = attachHost(sock, { stdin, stdout: term() as never });
    ended.then(() => { over = true; });
    await until("attached", async () => ((await link.call("host.hello")) as { clients: number }).clients === 1);
    stdin.write("\x03");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(over, false, "Ctrl-C does not leave an interactive attach");
    stdin.write("\x02d");
    await ended;
});

test("#3169 — when the size's owner leaves, the size passes to the interactive client left, without it typing", { skip }, async () => {
    const link = await startHost({ name: "sizes", argv: ["cat"], cwd: home, size: { rows: 20, cols: 70 }, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    cleanups.push(async () => { await link.call("host.shutdown").catch(() => {}); link.close(); });
    const sock = join(link.info.dir, "attach.sock");
    const term = (rows: number, columns: number) => Object.assign(new EventEmitter(), { rows, columns, write() { return true; } });
    const size = async () => ((await link.call("host.hello")) as { size: { rows: number; cols: number } }).size;

    const aIn = new PassThrough();
    const a = attachHost(sock, { stdin: aIn, stdout: term(39, 80) as never });
    await until("a attached", async () => ((await link.call("host.hello")) as { clients: number }).clients === 1);
    const bIn = new PassThrough();
    const b = attachHost(sock, { stdin: bIn, stdout: term(40, 120) as never });
    await until("b attached", async () => ((await link.call("host.hello")) as { clients: number }).clients === 2);
    aIn.write("x");
    await until("a owns the size", async () => { const s = await size(); return s.rows === 39 && s.cols === 80; });

    aIn.write("\x02d");
    assert.deepEqual(await a, { reason: "detached" });
    await until("the size passed to b", async () => { const s = await size(); return s.rows === 40 && s.cols === 120; });

    bIn.write("\x02d");
    await b;
    const left = await size();
    assert.deepEqual([left.rows, left.cols], [40, 120], "no interactive client left: the size stays");
});

test("#3166 — the copy bar: on the last row, in reverse video, cut to the width, the cursor put back", () => {
    const b = copyBar(30, 100, "cl-x");
    assert.ok(b.startsWith("\x1b7\x1b[30;1H\x1b[0;7m"), "saved cursor, last row, reverse video");
    assert.ok(b.endsWith("\x1b[0m\x1b8"), "attributes reset, cursor back");
    assert.match(b, /👁 COPY · read-only · cl-x · Ctrl-C or Ctrl-B D to leave/);
    const text = (cols: number) => copyBar(1, cols, "cl-x").replace(/^\x1b7\x1b\[1;1H\x1b\[0;7m/, "").replace(/\x1b\[0m\x1b8$/, "");
    const width = (t: string) => [...t].reduce((n, ch) => n + (/\p{Extended_Pictographic}/u.test(ch) ? 2 : 1), 0);
    for (const cols of [10, 40, 200]) assert.equal(width(text(cols)), cols, `exactly ${cols} cells`);
});
