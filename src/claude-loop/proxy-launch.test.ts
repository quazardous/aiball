/**
 * The refusal is the reason this file exists.
 *
 * The old code let a missing proxy fall through to a direct launch, and no
 * test on any platform ever executed that branch — the same shape #1613
 * described: something that looks covered and is not. So the cases below pin
 * the refusal itself, not just the happy paths, and one of them pins that a
 * refusal cannot be configured away.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveProxyLaunch, BUILD_CMD, type ProxyLaunchInput } from "./proxy-launch.js";

const RUST = "/p/windows/cl-pty-proxy/target/release/cl-pty-proxy";
const RUST_WIN = "/p/windows/cl-pty-proxy/target/release/cl-pty-proxy.exe";
const PY = "/p/src/claude-loop/pty-proxy.py";

/** Default: a Unix checkout with the python script on disk and nothing built. */
function input(over: Partial<ProxyLaunchInput> = {}): ProxyLaunchInput {
    return {
        platform: "linux",
        proxyImpl: "",
        rustProxyBin: RUST,
        pyProxy: PY,
        exists: (p) => p === PY,
        hasPython3: true,
        ...over,
    };
}

/** Only the named paths exist. */
const only = (...paths: string[]) => (p: string) => paths.includes(p);

test("win32: the built ConPTY proxy fronts claude", () => {
    const r = resolveProxyLaunch(input({
        platform: "win32", rustProxyBin: RUST_WIN, exists: only(RUST_WIN),
    }));
    assert.equal(r.kind, "rust");
    assert.equal(r.kind === "rust" && r.bin, RUST_WIN);
});

test("win32 without the built exe REFUSES, and names the build command", () => {
    const r = resolveProxyLaunch(input({
        platform: "win32", rustProxyBin: RUST_WIN, exists: () => false,
    }));
    assert.equal(r.kind, "refuse");
    assert.ok(r.kind === "refuse" && r.reason.includes(BUILD_CMD));
});

test("win32 refuses even when python3 and the script are there — no Python proxy on Windows", () => {
    // pty.fork() is POSIX. A `proxy_impl: python` carried over from a Unix
    // checkout must not silently produce a direct launch.
    const r = resolveProxyLaunch(input({
        platform: "win32", rustProxyBin: RUST_WIN, proxyImpl: "python",
        exists: only(PY), hasPython3: true,
    }));
    assert.equal(r.kind, "refuse");
});

test("unix: the built Rust proxy wins by default", () => {
    const r = resolveProxyLaunch(input({ exists: only(RUST, PY) }));
    assert.equal(r.kind, "rust");
});

test("unix: proxy_impl python takes the fallback even when Rust is built", () => {
    const r = resolveProxyLaunch(input({ proxyImpl: "python", exists: only(RUST, PY) }));
    assert.equal(r.kind, "python");
    assert.ok(r.kind === "python" && r.notice.includes("DEPRECATED"));
});

test("unix: Rust missing falls back to Python, and says so out loud", () => {
    const r = resolveProxyLaunch(input({ exists: only(PY) }));
    assert.equal(r.kind, "python");
    // The notice must carry the fix, not just the diagnosis (#1294).
    assert.ok(r.kind === "python" && r.notice.includes(BUILD_CMD));
});

test("unix with NEITHER engine refuses instead of launching claude directly", () => {
    const r = resolveProxyLaunch(input({ exists: () => false, hasPython3: false }));
    assert.equal(r.kind, "refuse");
    assert.ok(r.kind === "refuse" && r.reason.includes(BUILD_CMD));
});

test("unix: python asked for but python3 absent refuses, naming that choice", () => {
    const r = resolveProxyLaunch(input({ proxyImpl: "python", exists: only(PY), hasPython3: false }));
    assert.equal(r.kind, "refuse");
    assert.ok(r.kind === "refuse" && r.reason.includes("proxy_impl: python"));
});

test("no proxy_impl value can turn the refusal into a direct launch", () => {
    // david `<chat>` 2026-09-07: "inconditionnel, pas de proxy pas de loop".
    // The escape hatch that was considered and rejected was `proxy_impl: none`,
    // so pin it explicitly alongside the other things someone might type.
    for (const impl of ["none", "off", "direct", "disabled", "no", "0", "rust"]) {
        for (const platform of ["win32", "linux"] as const) {
            const r = resolveProxyLaunch(input({
                platform, proxyImpl: impl, exists: () => false, hasPython3: false,
            }));
            assert.equal(r.kind, "refuse", `${platform} / proxy_impl: ${impl} must refuse`);
        }
    }
});

test("every refusal explains why a missing proxy is fatal, not just that it is", () => {
    // A bare "not built" reads as an optional extra the user can dismiss —
    // which is exactly how this poste ran for weeks without a proxy.
    for (const platform of ["win32", "linux"] as const) {
        const r = resolveProxyLaunch(input({ platform, exists: () => false, hasPython3: false }));
        assert.equal(r.kind, "refuse");
        assert.ok(r.kind === "refuse" && /human type|AFK|inject/i.test(r.reason));
    }
});
