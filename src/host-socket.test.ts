/**
 * #3425 — a session host's socket on Windows is a loopback port and a token
 * in `<path>.addr`; on Unix it is the path, and nothing more is said. Tested
 * with the Windows branch on every system: it is loopback TCP.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { addressFile, connectHost, controlAuthLine, hostSocketPresent, readHostAddress, withToken } from "./host-socket.js";

const dir = mkdtempSync(join(tmpdir(), "aiball-3425-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("the address file sits beside the socket's path", () => {
    assert.equal(addressFile(join(dir, "attach.sock")), `${join(dir, "attach.sock")}.addr`);
});

test("an address is a port and a token, or nothing", () => {
    const sock = join(dir, "read.sock");
    writeFileSync(addressFile(sock), JSON.stringify({ port: 4312, token: "abc" }));
    assert.deepEqual(readHostAddress(sock), { port: 4312, token: "abc" });
    for (const text of ["", "{}", "not json", '{"port":0,"token":"abc"}', '{"port":4312}', '{"port":4312,"token":""}', '{"port":70000,"token":"abc"}', '{"port":"4312","token":"abc"}']) {
        writeFileSync(addressFile(sock), text);
        assert.equal(readHostAddress(sock), null, text);
    }
    assert.equal(readHostAddress(join(dir, "missing.sock")), null);
});

test("on Windows, the connection goes to the port and carries the token", async () => {
    const got: Buffer[] = [];
    const server = createServer((s: Socket) => s.on("data", (d) => got.push(d)));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const sock = join(dir, "control.sock");
    writeFileSync(addressFile(sock), JSON.stringify({ port: (server.address() as AddressInfo).port, token: "t0k" }));
    const { socket, token } = connectHost(sock, "win32");
    assert.equal(token, "t0k");
    await new Promise<void>((r) => socket.once("connect", () => r()));
    socket.write(controlAuthLine(token));
    socket.end();
    await new Promise<void>((r) => server.close(() => r()));
    assert.deepEqual(JSON.parse(Buffer.concat(got).toString()), { jsonrpc: "2.0", method: "host.auth", params: { token: "t0k" } });
});

test("on Windows, no address file fails as a missing socket does", async () => {
    const { socket, token } = connectHost(join(dir, "gone.sock"), "win32");
    assert.equal(token, null);
    const e = await new Promise<NodeJS.ErrnoException>((r) => socket.once("error", r));
    assert.equal(e.code, "ENOENT");
});

test("without a token nothing more is said: no auth line, the hello as it was", () => {
    assert.equal(controlAuthLine(null), "");
    assert.deepEqual(withToken({ version: 1 }, null), { version: 1 });
    assert.deepEqual(withToken({ version: 1 }, "t0k"), { version: 1, token: "t0k" });
});

test("a host's socket is there: its file on Unix, a readable address on Windows", () => {
    const sock = join(dir, "present.sock");
    assert.equal(hostSocketPresent(sock, "win32"), false);
    assert.equal(hostSocketPresent(sock, "linux"), false);
    writeFileSync(addressFile(sock), JSON.stringify({ port: 4312, token: "abc" }));
    // The kernel's boot check: a Windows host has nothing at the path itself.
    assert.equal(hostSocketPresent(sock, "win32"), true);
    assert.equal(hostSocketPresent(sock, "linux"), false);
    writeFileSync(sock, "");
    assert.equal(hostSocketPresent(sock, "linux"), true);
    writeFileSync(addressFile(sock), "{}");
    assert.equal(hostSocketPresent(sock, "win32"), false);
});
