/**
 * Upstream coupling phase 2 — githubProvider.fetchIssue (Slice 0). Pure unit
 * test with an injected fetch stub: no network, no db. Verifies the field
 * mapping (state/labels/body), the PR guard, HTTP error surfacing, and that
 * the token becomes an Authorization header.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { githubProvider, providerByKind } from "./upstream-providers.js";

type FetchArgs = { url: string; headers: Record<string, string> };

function stubFetch(status: number, payload: unknown): { impl: typeof fetch; calls: FetchArgs[] } {
    const calls: FetchArgs[] = [];
    const impl = (async (url: string, init?: { headers?: Record<string, string> }) => {
        calls.push({ url, headers: init?.headers ?? {} });
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => payload,
        };
    }) as unknown as typeof fetch;
    return { impl, calls };
}

const target = { owner: "acme", repo: "widgets" };

test("fetchIssue maps title/body/state/labels + hits the right URL", async () => {
    const { impl, calls } = stubFetch(200, {
        number: 42,
        title: "Crash on save",
        body: "steps to repro",
        state: "open",
        html_url: "https://github.com/acme/widgets/issues/42",
        labels: [{ name: "bug" }, "urgent"],
    });
    const issue = await githubProvider.fetchIssue!(target, 42, { fetchImpl: impl });
    assert.equal(issue.num, 42);
    assert.equal(issue.title, "Crash on save");
    assert.equal(issue.body, "steps to repro");
    assert.equal(issue.state, "open");
    assert.deepEqual(issue.labels, ["bug", "urgent"]);
    assert.equal(issue.url, "https://github.com/acme/widgets/issues/42");
    assert.equal(calls[0].url, "https://api.github.com/repos/acme/widgets/issues/42");
});

test("fetchIssue: null body → empty string; unknown state → open", async () => {
    const { impl } = stubFetch(200, {
        number: 7, title: "T", body: null, state: "weird",
        html_url: "u", labels: [],
    });
    const issue = await githubProvider.fetchIssue!(target, 7, { fetchImpl: impl });
    assert.equal(issue.body, "");
    assert.equal(issue.state, "open");
});

test("fetchIssue: closed state preserved", async () => {
    const { impl } = stubFetch(200, {
        number: 7, title: "T", body: "", state: "closed", html_url: "u", labels: [],
    });
    const issue = await githubProvider.fetchIssue!(target, 7, { fetchImpl: impl });
    assert.equal(issue.state, "closed");
});

test("fetchIssue: a pull request is rejected (not an issue)", async () => {
    const { impl } = stubFetch(200, {
        number: 9, title: "PR", body: "", state: "open", html_url: "u", labels: [],
        pull_request: { url: "..." },
    });
    await assert.rejects(
        () => githubProvider.fetchIssue!(target, 9, { fetchImpl: impl }),
        /pull request/,
    );
});

test("fetchIssue: HTTP error surfaces status + hint", async () => {
    const { impl } = stubFetch(404, {});
    await assert.rejects(
        () => githubProvider.fetchIssue!(target, 1, { fetchImpl: impl }),
        /HTTP 404/,
    );
});

test("fetchIssue: token becomes a Bearer Authorization header", async () => {
    const { impl, calls } = stubFetch(200, {
        number: 1, title: "T", body: "", state: "open", html_url: "u", labels: [],
    });
    await githubProvider.fetchIssue!(target, 1, { fetchImpl: impl, token: "secret-tok" });
    assert.equal(calls[0].headers["authorization"], "Bearer secret-tok");
});

test("fetchIssue: no token → no Authorization header", async () => {
    const { impl, calls } = stubFetch(200, {
        number: 1, title: "T", body: "", state: "open", html_url: "u", labels: [],
    });
    await githubProvider.fetchIssue!(target, 1, { fetchImpl: impl });
    assert.equal(calls[0].headers["authorization"], undefined);
});

test("providerByKind resolves github and rejects unknown", () => {
    assert.equal(providerByKind("github")?.id, "github");
    assert.equal(providerByKind("bogus"), null);
});

test("createIssue POSTs title/body and maps the created issue", async () => {
    const { impl, calls } = stubFetch(201, {
        number: 77,
        title: "New from aiball",
        body: "the body",
        state: "open",
        html_url: "https://github.com/acme/widgets/issues/77",
    });
    const issue = await githubProvider.createIssue!(
        target, { title: "New from aiball", body: "the body" }, { fetchImpl: impl, token: "wtok" },
    );
    assert.equal(issue.num, 77);
    assert.equal(issue.url, "https://github.com/acme/widgets/issues/77");
    assert.equal(calls[0].url, "https://api.github.com/repos/acme/widgets/issues");
    assert.equal(calls[0].headers["authorization"], "Bearer wtok");
});

test("createIssue without a token is refused (write needs auth)", async () => {
    const { impl } = stubFetch(201, {});
    await assert.rejects(
        () => githubProvider.createIssue!(target, { title: "x", body: "y" }, { fetchImpl: impl }),
        /needs a write-scoped token/,
    );
});

test("createIssue surfaces an HTTP error", async () => {
    const { impl } = stubFetch(403, {});
    await assert.rejects(
        () => githubProvider.createIssue!(target, { title: "x", body: "y" }, { fetchImpl: impl, token: "t" }),
        /HTTP 403/,
    );
});
