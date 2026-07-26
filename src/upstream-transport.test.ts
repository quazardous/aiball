// #1563 — the transport seam. The happy path is easy; the failures are the
// reason this layer exists, so they get most of the cases.
//
// Run: `npx tsx --test src/upstream-transport.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ghStatusFrom, ghTransport, httpTransport } from "./upstream-transport.js";

// --- reading a status out of `gh api`'s leftovers --------------------------

test("ghStatusFrom: reads the status from stdout's error JSON", () => {
    // Verbatim from `gh api repos/quazardous/aiball/issues/999999`.
    const stdout = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}';
    const stderr = "gh: Not Found (HTTP 404)\n";
    assert.equal(ghStatusFrom(stdout, stderr).status, 404);
});

test("ghStatusFrom: `status` is a STRING in GitHub's error JSON — a === 404 would miss", () => {
    const { status } = ghStatusFrom('{"status":"403"}', "");
    assert.equal(typeof status, "number");
    assert.equal(status, 403);
});

test("ghStatusFrom: falls back to stderr when stdout isn't JSON", () => {
    assert.equal(ghStatusFrom("", "gh: Not Found (HTTP 404)\n").status, 404);
});

test("ghStatusFrom: 0 when neither source carries a status", () => {
    // The CLI itself broke — not an HTTP answer.
    assert.equal(ghStatusFrom("", "gh: could not connect\n").status, 0);
});

test("ghStatusFrom: ignores a non-numeric status rather than yielding NaN", () => {
    assert.equal(ghStatusFrom('{"status":"nope"}', "").status, 0);
});

// --- gh transport ----------------------------------------------------------

/** Stub the child-process runner so no `gh` is spawned. */
function fakeRun(script: Record<string, { code: number; stdout?: string; stderr?: string }>) {
    const calls: string[][] = [];
    const impl = async (_cmd: string, args: string[]) => {
        calls.push(args);
        const key = args.slice(0, 2).join(" ");
        const hit = script[key] ?? script[args[0]!] ?? { code: 0, stdout: "{}" };
        return { code: hit.code, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
    };
    return { impl, calls };
}

test("gh probe: not installed → not ok, and says so", async () => {
    const { impl } = fakeRun({ "--version": { code: 127, stderr: "not found" } });
    const p = await ghTransport({ runImpl: impl }).probe();
    assert.equal(p.ok, false);
    assert.match(p.detail, /not installed/);
});

test("gh probe: installed but logged out → not ok, points at `gh auth login`", async () => {
    const { impl } = fakeRun({
        "--version": { code: 0, stdout: "gh version 2.0.0" },
        "auth status": { code: 1, stderr: "You are not logged into any GitHub hosts" },
    });
    const p = await ghTransport({ runImpl: impl }).probe();
    assert.equal(p.ok, false);
    assert.match(p.detail, /gh auth login/);
});

test("gh probe: authenticated → ok, names the account", async () => {
    const { impl } = fakeRun({
        "--version": { code: 0, stdout: "gh version 2.0.0" },
        "auth status": { code: 0, stderr: "✓ Logged in to github.com account quazardous (keyring)" },
    });
    const p = await ghTransport({ runImpl: impl }).probe();
    assert.equal(p.ok, true);
    assert.match(p.detail, /quazardous/);
});

test("gh request: success returns the parsed body", async () => {
    const { impl, calls } = fakeRun({ "api repos/o/r/issues/1": { code: 0, stdout: '{"number":1}' } });
    const r = await ghTransport({ runImpl: impl }).request("repos/o/r/issues/1");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { number: 1 });
    assert.deepEqual(calls[0], ["api", "repos/o/r/issues/1"]);
});

test("gh request: a 404 is RETURNED, not thrown — the provider owns the hint", async () => {
    const { impl } = fakeRun({
        "api repos/o/r/issues/9": { code: 1, stdout: '{"status":"404"}', stderr: "gh: Not Found (HTTP 404)" },
    });
    const r = await ghTransport({ runImpl: impl }).request("repos/o/r/issues/9");
    assert.equal(r.status, 404);
});

test("gh request: a broken wire THROWS, and the message names the transport", async () => {
    const { impl } = fakeRun({
        "api repos/o/r/issues/1": { code: 1, stderr: "could not connect to github.com" },
    });
    await assert.rejects(
        () => ghTransport({ runImpl: impl }).request("repos/o/r/issues/1"),
        /^Error: gh: could not connect/,
    );
});

test("gh request: a body goes through stdin, never the argv", async () => {
    const { impl, calls } = fakeRun({ "api repos/o/r/issues": { code: 0, stdout: "{}" } });
    await ghTransport({ runImpl: impl }).request("repos/o/r/issues", {
        method: "POST",
        body: { title: "a \"quoted\" title; rm -rf /" },
    });
    assert.deepEqual(calls[0], ["api", "repos/o/r/issues", "-X", "POST", "--input", "-"]);
    assert.ok(!calls[0]!.join(" ").includes("rm -rf"), "the body must not reach argv");
});

// --- http transport --------------------------------------------------------

test("http probe: no token is reported, not treated as a failure", async () => {
    const p = await httpTransport({}).probe();
    assert.equal(p.ok, true);
    assert.match(p.detail, /no token/);
});

test("http request: a 404 is returned, not thrown", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const r = await httpTransport({ fetchImpl }).request("repos/o/r/issues/9");
    assert.equal(r.status, 404);
});

test("http request: a network failure throws, named", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    await assert.rejects(
        () => httpTransport({ fetchImpl }).request("repos/o/r/issues/1"),
        /^Error: http: ECONNREFUSED/,
    );
});

test("http request: the token rides as a Bearer header when set", async () => {
    let seen: Record<string, string> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
        seen = init.headers as Record<string, string>;
        return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await httpTransport({ token: "tok", fetchImpl }).request("repos/o/r/issues/1");
    assert.equal(seen["authorization"], "Bearer tok");
});
