// #2282 — the machine section of `aiball check`, judged from simulated probes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    assembleMachineReport,
    serveHandlesDaemon,
    tailscaleUrl,
    type MachineLine,
    type MachineProbes,
} from "./machine-check.js";
import { BUILD_CMD } from "./claude-loop/proxy-launch.js";

/** A healthy Linux box: every probe passes, no tailscale configured. */
function healthy(over: Partial<MachineProbes> = {}): MachineProbes {
    return {
        cliVersion: "0.40.0",
        socket: { path: "/home/u/.local/share/aiball/sock", exists: true },
        transport: "socket",
        daemon: { up: true, version: "0.40.0", error: null },
        auth: { ready: true, install_available: false, install_expires_at: null, me: null },
        agent: "proj-claude",
        tmux: { cmd: "tmux", version: "tmux 3.7c", install: "sudo dnf install tmux" },
        claude: { cmd: "claude", version: "2.1.270 (Claude Code)", install: null },
        proxy: { kind: "rust", bin: "/x/cl-pty-proxy" },
        cargo: { present: true, install: null },
        tailscale: null,
        ...over,
    };
}

const line = (lines: MachineLine[], id: MachineLine["id"]) => {
    const l = lines.find((x) => x.id === id);
    assert.ok(l, `expected a ${id} line`);
    return l;
};

test("a healthy machine reports every line ok, and no tailscale line when none is configured", () => {
    const lines = assembleMachineReport(healthy());
    assert.deepEqual(lines.map((l) => l.id), ["daemon", "socket", "caller", "web_login", "tmux", "claude", "pty_proxy"]);
    assert.ok(lines.every((l) => l.status === "ok"), JSON.stringify(lines));
});

test("daemon down is an error naming how to start it; the socket line follows it", () => {
    const lines = assembleMachineReport(healthy({
        daemon: { up: false, version: null, error: "connect ENOENT" },
        socket: { path: "/s", exists: false },
        auth: null,
    }));
    const d = line(lines, "daemon");
    assert.equal(d.status, "error");
    assert.match(d.detail, /ENOENT/);
    assert.equal(d.fix, "systemctl --user start aiball");
    assert.equal(line(lines, "socket").status, "error");
    assert.equal(lines.find((l) => l.id === "web_login"), undefined, "no auth answer, no web-login verdict");
});

test("a daemon running another version than the CLI asks for a restart", () => {
    const d = line(assembleMachineReport(healthy({ daemon: { up: true, version: "0.39.2", error: null } })), "daemon");
    assert.equal(d.status, "warn");
    assert.match(d.detail, /0\.39\.2.*0\.40\.0/);
    assert.equal(d.fix, "aiball restart");
});

test("an up daemon whose socket vanished warns — the restart rebinds it", () => {
    const s = line(assembleMachineReport(healthy({ socket: { path: "/s", exists: false } })), "socket");
    assert.equal(s.status, "warn");
    assert.equal(s.fix, "aiball restart");
});

test("no socket expected (Windows / AIBALL_SOCK=\"\") means no socket line at all", () => {
    const lines = assembleMachineReport(healthy({ socket: null }));
    assert.equal(lines.find((l) => l.id === "socket"), undefined);
});

test("caller: token accepted, token rejected, nothing at all", () => {
    const accepted = line(assembleMachineReport(healthy({
        transport: "token",
        auth: { ready: true, install_available: false, install_expires_at: null, me: { consumer_id: "proj-claude", kind: "agent" } },
    })), "caller");
    assert.equal(accepted.status, "ok");
    assert.match(accepted.detail, /proj-claude/);

    const rejected = line(assembleMachineReport(healthy({ transport: "token" })), "caller");
    assert.equal(rejected.status, "error");
    assert.equal(rejected.fix, "aiball auth issue --consumer proj-claude, then export AIBALL_TOKEN");

    const none = line(assembleMachineReport(healthy({ transport: "none" })), "caller");
    assert.equal(none.status, "error");
    assert.match(none.fix ?? "", /aiball auth issue/);
});

test("web login: pending setup shows the install token's expiry; nothing at all needs reinit", () => {
    const pending = line(assembleMachineReport(healthy({
        auth: { ready: false, install_available: true, install_expires_at: "2026-09-15T10:00:00.000Z", me: null },
    })), "web_login");
    assert.equal(pending.status, "warn");
    assert.match(pending.detail, /until 2026-09-15T10:00:00\.000Z/);

    const dead = line(assembleMachineReport(healthy({
        auth: { ready: false, install_available: false, install_expires_at: null, me: null },
    })), "web_login");
    assert.equal(dead.status, "error");
    assert.equal(dead.fix, "aiball auth reinit");

    const stillOpen = line(assembleMachineReport(healthy({
        auth: { ready: true, install_available: true, install_expires_at: "2026-09-15T10:00:00.000Z", me: null },
    })), "web_login");
    assert.equal(stillOpen.status, "warn");
    assert.match(stillOpen.fix ?? "", /aiball auth revoke/);
});

test("a missing tool is an error carrying the package manager's install command", () => {
    const lines = assembleMachineReport(healthy({
        tmux: { cmd: "tmux", version: null, install: "sudo dnf install tmux" },
        claude: { cmd: "claude", version: null, install: null },
    }));
    assert.equal(line(lines, "tmux").status, "error");
    assert.equal(line(lines, "tmux").fix, "sudo dnf install tmux");
    assert.equal(line(lines, "claude").fix, "npm install -g @anthropic-ai/claude-code");
});

test("PTY proxy: the Python fallback says WHY — unbuilt, or no cargo to build it", () => {
    const python = { kind: "python", script: "/x/pty-proxy.py", notice: "" } as const;
    const unbuilt = line(assembleMachineReport(healthy({ proxy: python })), "pty_proxy");
    assert.equal(unbuilt.status, "warn");
    assert.match(unbuilt.detail, /not built/);
    assert.equal(unbuilt.fix, BUILD_CMD);

    const noCargo = line(assembleMachineReport(healthy({
        proxy: python, cargo: { present: false, install: "sudo dnf install cargo" },
    })), "pty_proxy");
    assert.match(noCargo.detail, /cargo is not installed/);
    assert.equal(noCargo.fix, `sudo dnf install cargo, then ${BUILD_CMD}`);

    const refuse = line(assembleMachineReport(healthy({ proxy: { kind: "refuse", reason: "x" } })), "pty_proxy");
    assert.equal(refuse.status, "error");
});

test("tailscale: each broken stage names its own fix; a working serve prints the URL", () => {
    const ts = {
        mode: "https" as const, listen: 8443, path: "/aiball", enabled: true,
        installed: true, running: true, dnsName: "box.tail1.ts.net", serving: true,
    };
    const ok = line(assembleMachineReport(healthy({ tailscale: ts })), "tailscale");
    assert.equal(ok.status, "ok");
    assert.equal(ok.detail, "serving https://box.tail1.ts.net:8443/aiball");

    const cases: Array<[Partial<typeof ts>, string]> = [
        [{ installed: false, running: false, serving: false }, "install tailscale — https://tailscale.com/download"],
        [{ running: false, serving: false }, "sudo tailscale up"],
        [{ serving: false }, "aiball providers up --all"],
    ];
    for (const [over, fix] of cases) {
        const l = line(assembleMachineReport(healthy({ tailscale: { ...ts, ...over } })), "tailscale");
        assert.equal(l.status, "error", JSON.stringify(over));
        assert.equal(l.fix, fix);
    }

    const disabled = line(assembleMachineReport(healthy({ tailscale: { ...ts, enabled: false, serving: false } })), "tailscale");
    assert.equal(disabled.status, "ok");
});

test("tailscaleUrl drops the scheme's default port", () => {
    assert.equal(tailscaleUrl({ mode: "https", listen: 443, dnsName: "b.ts.net" }), "https://b.ts.net/");
    assert.equal(tailscaleUrl({ mode: "http", listen: 80, path: "/a", dnsName: "b.ts.net" }), "http://b.ts.net/a");
    assert.equal(tailscaleUrl({ mode: "http", listen: 8080, dnsName: "b.ts.net" }), "http://b.ts.net:8080/");
});

test("serveHandlesDaemon matches port, path and the daemon's port — nothing looser", () => {
    const status = {
        Web: {
            "box.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" }, "/aiball": { Proxy: "http://127.0.0.1:7777" } } },
        },
    };
    assert.equal(serveHandlesDaemon(status, 8443, "/aiball", 7777), true);
    assert.equal(serveHandlesDaemon(status, 443, "/aiball", 7777), false, "other listen port");
    assert.equal(serveHandlesDaemon(status, 8443, undefined, 7777), false, "root handler proxies elsewhere");
    assert.equal(serveHandlesDaemon(status, 8443, "/aiball", 77), false, "port suffix must not match a prefix");
    assert.equal(serveHandlesDaemon(null, 8443, "/aiball", 7777), false);
});
