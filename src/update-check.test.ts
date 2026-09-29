/**
 * #2586 — the tray, the GNOME extension and `aiball version` show the version
 * and whether an update is out. What must hold:
 * - versions compare as numbers, and a pre-release or draft is never "latest";
 * - an update is "available" against what is INSTALLED, a restart is "needed"
 *   when what runs is not what is installed;
 * - the daemon's check never throws, runs once at a time, and answers its cache
 *   within a minute;
 * - the update command keeps the install's mode (release / edge / dev) and flags;
 * - `/api/version` is public and names the mode, never the source path;
 *   `updates.check: false` means no outbound call.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const HOME = mkdtempSync(join(tmpdir(), "aiball-2586-"));
process.env.AIBALL_HOME = join(HOME, "data");
process.env.AIBALL_SOCK = "";
process.env.XDG_CONFIG_HOME = join(HOME, "config");
after(() => rmSync(HOME, { recursive: true, force: true }));

const {
    compareVersions, latestFromRelease, versionView, runUpdateCheck, resetUpdateCheckForTest, CHECK_MIN_INTERVAL_MS,
} = await import("./update-check.js");
const { parseInstallInfo, updateCommand, installInfoPath } = await import("./install-info.js");

test("versions compare as numbers, v-prefixed or not; anything else does not compare", () => {
    assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
    assert.equal(compareVersions("v0.41.0", "0.41.0"), 0);
    assert.equal(compareVersions("0.41.0", "0.42.0"), -1);
    assert.equal(compareVersions("0.42.0-rc1", "0.41.0"), null);
    assert.equal(compareVersions(null, "0.41.0"), null);
});

test("the latest release is a published x.y.z tag, never a draft or pre-release", () => {
    assert.deepEqual(latestFromRelease({ tag_name: "v0.42.0", html_url: "https://x/r" }), { version: "0.42.0", url: "https://x/r" });
    assert.equal(latestFromRelease({ tag_name: "v0.43.0", prerelease: true }), null);
    assert.equal(latestFromRelease({ tag_name: "v0.43.0", draft: true }), null);
    assert.equal(latestFromRelease({ tag_name: "nightly" }), null);
    assert.equal(latestFromRelease(null), null);
});

const checked = (latest: string | null) => ({ latest, release_url: null, checked_at: "2026-09-16T00:00:00.000Z", error: null });

test("an update is judged against what is installed, a restart against what runs", () => {
    const upToDate = versionView("0.41.0", "0.41.0", checked("0.41.0"), false);
    assert.equal(upToDate.update_available, false);
    assert.equal(upToDate.restart_needed, false);

    const out = versionView("0.41.0", "0.41.0", checked("0.42.0"), false);
    assert.equal(out.update_available, true);

    const pulled = versionView("0.41.0", "0.42.0", checked("0.42.0"), false);
    assert.equal(pulled.update_available, false, "installed already, only the restart is missing");
    assert.equal(pulled.restart_needed, true);

    assert.equal(versionView("0.41.0", "0.41.0", checked(null), false).update_available, false, "never checked: nothing to claim");
});

function fakeFetch(answers: Array<() => { ok: boolean; status: number; body?: unknown }>) {
    const calls: string[] = [];
    const impl = async (url: string) => {
        calls.push(url);
        const a = answers.shift();
        if (!a) throw new Error("unexpected call");
        const r = a();
        return { ok: r.ok, status: r.status, json: async () => r.body };
    };
    return { impl, calls };
}

test("the check records the latest release, and a failure without throwing, keeping the last good answer", async () => {
    resetUpdateCheckForTest();
    const t0 = Date.parse("2026-09-16T10:00:00Z");
    const f = fakeFetch([
        () => ({ ok: true, status: 200, body: { tag_name: "v0.42.0", html_url: "https://gh/rel" } }),
        () => { throw new Error("getaddrinfo ENOTFOUND api.github.com"); },
        () => ({ ok: false, status: 403 }),
    ]);
    const ok = await runUpdateCheck(f.impl, t0);
    assert.equal(ok.latest, "0.42.0");
    assert.equal(ok.error, null);

    const offline = await runUpdateCheck(f.impl, t0 + CHECK_MIN_INTERVAL_MS + 1);
    assert.equal(offline.latest, "0.42.0", "an offline check keeps what was known");
    assert.match(offline.error ?? "", /ENOTFOUND/);

    const limited = await runUpdateCheck(f.impl, t0 + 2 * (CHECK_MIN_INTERVAL_MS + 1));
    assert.match(limited.error ?? "", /403/);
    assert.equal(f.calls.length, 3);
});

test("one call at a time, and within a minute the cache answers", async () => {
    resetUpdateCheckForTest();
    const t0 = Date.parse("2026-09-16T11:00:00Z");
    const f = fakeFetch([() => ({ ok: true, status: 200, body: { tag_name: "v0.42.0" } })]);
    const [a, b] = await Promise.all([runUpdateCheck(f.impl, t0), runUpdateCheck(f.impl, t0)]);
    assert.deepEqual(a, b);
    const again = await runUpdateCheck(f.impl, t0 + CHECK_MIN_INTERVAL_MS - 1);
    assert.equal(again.latest, "0.42.0");
    assert.equal(f.calls.length, 1, "no second call to GitHub");
});

test("the update command keeps the install's mode and flags, per platform", () => {
    const rel = parseInstallInfo(JSON.stringify({ mode: "release", source: "/home/u/aiball", flags: ["--port", "7878"] }), "linux");
    assert.equal(updateCommand(rel), "cd /home/u/aiball && git pull --ff-only --tags && ./install.sh --port 7878");

    const edge = parseInstallInfo(JSON.stringify({ mode: "edge", source: "/home/u/my aiball", flags: [] }), "linux");
    assert.equal(updateCommand(edge), "cd '/home/u/my aiball' && git pull --ff-only --tags && ./install.sh --edge");

    const dev = parseInstallInfo(JSON.stringify({ mode: "dev", source: "/src/aiball" }), "linux");
    assert.equal(updateCommand(dev), "cd /src/aiball && git pull --ff-only --tags && npm install && npm --prefix frontend run build && aiball restart");

    const win = parseInstallInfo(JSON.stringify({ mode: "edge", source: "C:\\Users\\u\\aiball", flags: ["-Port", "7878"] }), "win32");
    assert.equal(updateCommand(win), "Set-Location C:\\Users\\u\\aiball; git pull --ff-only --tags; .\\install.ps1 -Port 7878");

    assert.equal(parseInstallInfo(`\uFEFF${JSON.stringify({ mode: "dev", source: "C:\\a" })}`, "win32").mode, "dev", "a BOM from PowerShell 5.1 still reads");
    const old = parseInstallInfo(null, "linux");
    assert.equal(old.mode, "unknown");
    assert.match(updateCommand(old), /re-run \.\/install\.sh/);
    assert.equal(parseInstallInfo("{broken", "linux").mode, "unknown");
    assert.equal(parseInstallInfo(JSON.stringify({ mode: "sideways", source: "/x" }), "linux").mode, "unknown");
});

test("/api/version is public, names the mode and not the source; updates.check: false makes no call", async () => {
    resetUpdateCheckForTest();
    mkdirSync(join(HOME, "config", "aiball"), { recursive: true });
    writeFileSync(installInfoPath(), JSON.stringify({ mode: "release", source: "/secret/clone", flags: [] }));

    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ tag_name: "v99.0.0", html_url: "https://gh/rel" }), { status: 200 });
    }) as typeof fetch;

    const { createApp } = await import("./app.js");
    const { setConfigOverride } = await import("./db/config-overrides.js");
    const server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
        const before = await realFetch(`${base}/api/version`);
        assert.equal(before.status, 200, "no token needed");
        const b = await before.json() as Record<string, unknown>;
        assert.equal(b.mode, "release");
        assert.equal(b.latest, null);
        assert.ok(!JSON.stringify(b).includes("/secret/clone"), "the source path stays local");

        const checkedNow = await (await realFetch(`${base}/api/version/check`, { method: "POST" })).json() as Record<string, unknown>;
        assert.equal(checkedNow.latest, "99.0.0");
        assert.equal(checkedNow.update_available, true);
        assert.equal(calls.length, 1);

        resetUpdateCheckForTest();
        setConfigOverride("", "updates.check", false);
        const off = await (await realFetch(`${base}/api/version/check`, { method: "POST" })).json() as Record<string, unknown>;
        assert.equal(off.check_disabled, true);
        assert.equal(off.latest, null);
        assert.equal(calls.length, 1, "no outbound call once turned off");
    } finally {
        globalThis.fetch = realFetch;
        server.close();
    }
});
