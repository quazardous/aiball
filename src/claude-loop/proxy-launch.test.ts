/**
 * The refusal is the reason this file exists.
 *
 * The old code let a missing proxy fall through to a direct launch, and no
 * test on any platform ever executed that branch — the same shape #1613
 * described: something that looks covered and is not. So the cases below pin
 * the refusal itself, not just the happy paths, and one of them pins that a
 * refusal cannot be configured away.
 *
 * #3043 — the Rust proxy is the only one: no Python fallback, no `proxy_impl`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveProxyLaunch, BUILD_CMD, type ProxyLaunchInput } from "./proxy-launch.js";

const RUST = "/p/windows/cl-pty-proxy/target/release/cl-pty-proxy";
const RUST_WIN = "/p/windows/cl-pty-proxy/target/release/cl-pty-proxy.exe";
const PACKAGED = "/opt/cl-pty-proxy/cl-pty-proxy";

/** Default: a Unix checkout with nothing built. */
function input(over: Partial<ProxyLaunchInput> = {}): ProxyLaunchInput {
    return { platform: "linux", rustProxyBin: RUST, exists: () => false, ...over };
}

/** Only the named paths exist. */
const only = (...paths: string[]) => (p: string) => paths.includes(p);

test("win32: the built ConPTY proxy fronts claude", () => {
    const r = resolveProxyLaunch(input({ platform: "win32", rustProxyBin: RUST_WIN, exists: only(RUST_WIN) }));
    assert.deepEqual(r, { kind: "rust", bin: RUST_WIN });
});

test("unix: the built Rust proxy fronts claude", () => {
    assert.deepEqual(resolveProxyLaunch(input({ exists: only(RUST) })), { kind: "rust", bin: RUST });
});

test("without the built proxy, both platforms REFUSE and name the build command", () => {
    for (const [platform, bin] of [["win32", RUST_WIN], ["linux", RUST]] as const) {
        const r = resolveProxyLaunch(input({ platform, rustProxyBin: bin }));
        assert.equal(r.kind, "refuse");
        assert.ok(r.kind === "refuse" && r.reason.includes(BUILD_CMD), platform);
    }
});

test("CL_PROXY_BIN picks another built binary", () => {
    const r = resolveProxyLaunch(input({ overrideBin: PACKAGED, exists: only(PACKAGED) }));
    assert.deepEqual(r, { kind: "rust", bin: PACKAGED });
});

test("CL_PROXY_BIN on a missing file refuses, naming it — it never means no proxy", () => {
    const r = resolveProxyLaunch(input({ overrideBin: PACKAGED, exists: only(RUST) }));
    assert.equal(r.kind, "refuse", "the checkout's build does not stand in silently");
    assert.ok(r.kind === "refuse" && r.reason.includes(PACKAGED));
});

test("nothing can turn the refusal into a direct launch", () => {
    // david `<chat>` 2026-09-07: "inconditionnel, pas de proxy pas de loop".
    for (const override of [undefined, "", "none", "off", "direct", "0"]) {
        for (const platform of ["win32", "linux"] as const) {
            const r = resolveProxyLaunch(input({ platform, overrideBin: override }));
            assert.equal(r.kind, "refuse", `${platform} / CL_PROXY_BIN=${String(override)} must refuse`);
        }
    }
});

test("every refusal explains why a missing proxy is fatal, not just that it is", () => {
    // A bare "not built" reads as an optional extra the user can dismiss —
    // which is exactly how this poste ran for weeks without a proxy.
    for (const platform of ["win32", "linux"] as const) {
        for (const overrideBin of [undefined, PACKAGED]) {
            const r = resolveProxyLaunch(input({ platform, overrideBin }));
            assert.ok(r.kind === "refuse" && /human type|AFK|inject/i.test(r.reason));
        }
    }
});
