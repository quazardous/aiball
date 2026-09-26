/**
 * #3066 3b — the terminal port over a real session host: the kernel reads the
 * screen the host announces and types through `host.inject`, while the daemon
 * keeps its own connection to the same `control.sock`. Needs the host built
 * (cargo); skipped, and says so, without it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const home = mkdtempSync("/tmp/aiball-3066b-");
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
const built = ["release", "debug"].map((b) => resolve(import.meta.dirname, "..", "..", "windows", "cl-pty-proxy", "target", b, "cl-session-host")).find(existsSync);
process.env.CL_SESSION_HOST_BIN = process.env.CL_SESSION_HOST_BIN ?? built ?? "";
const skip = existsSync(process.env.CL_SESSION_HOST_BIN) ? false : "no cl-session-host built (cargo build --manifest-path windows/cl-pty-proxy/Cargo.toml)";

const { startHost } = await import("../sessions/hosts.js");
const { hostPort } = await import("./terminal-port.js");

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
    for (const c of cleanups) await c();
    rmSync(home, { recursive: true, force: true });
});

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!ok()) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

test("the host port reads the screen and types, beside the daemon's own connection", { skip }, async () => {
    const link = await startHost({ name: "port", argv: ["cat"], cwd: home, size: { rows: 12, cols: 60 }, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    cleanups.push(async () => { await link.call("host.shutdown").catch(() => {}); link.close(); });
    const logs: string[] = [];
    const port = hostPort({ controlSocket: join(link.info.dir, "control.sock"), log: (m) => logs.push(m) });
    cleanups.push(() => port.close());
    await port.ready;
    assert.equal(port.kind, "host");
    assert.equal(port.alive(), true);

    let willInject = 0;
    assert.equal(await port.inject("wake from the kernel", () => { willInject++; }), true);
    assert.equal(willInject, 1, "the caller's markers are armed before the write");
    await until("the phrase on the screen", () => port.screen().text.includes("wake from the kernel"));
    assert.ok(port.screen().cursor, "the cursor comes with the text");

    assert.equal(await port.injectRaw("raw bytes\r"), true);
    await until("the raw bytes on the screen", () => port.screen().text.includes("raw bytes"));

    // The daemon's connection still answers: two controllers at once.
    const hello = await link.call("host.hello") as { claude: { running: boolean } };
    assert.equal(hello.claude.running, true);

    port.end();
    await until("Claude gone", () => !port.alive());
    assert.deepEqual(logs, [], "nothing went wrong on the way");
});
