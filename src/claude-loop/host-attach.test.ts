/**
 * #3066 — `claude-loop attach` on a loop that runs on the session host: the
 * detach keys, then a real host — its screen shown, the keys typed reaching
 * the session, the terminal's size followed, and a detach that stops nothing.
 * The host part needs it built (cargo); skipped, and says so, without it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { DetachKeys, attachHost } from "./host-attach.js";

const home = mkdtempSync("/tmp/aiball-3066-attach-");
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
const built = ["release", "debug"].map((b) => resolve(import.meta.dirname, "..", "..", "windows", "cl-pty-proxy", "target", b, "cl-session-host")).find(existsSync);
process.env.CL_SESSION_HOST_BIN = process.env.CL_SESSION_HOST_BIN ?? built ?? "";
const skip = existsSync(process.env.CL_SESSION_HOST_BIN) ? false : "no cl-session-host built (cargo build --manifest-path windows/cl-pty-proxy/Cargo.toml)";

const { startHost } = await import("../sessions/hosts.js");
const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
    for (const c of cleanups) await c();
    rmSync(home, { recursive: true, force: true });
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

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await ok())) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

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
