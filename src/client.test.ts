/**
 * #855 — MCP client retry-with-backoff unit tests. The actual http()
 * wiring is exercised by integration paths ; these tests pin the policy
 * (which errors trigger a retry, how many attempts, backoff sequence)
 * on the exported helpers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry, isRetriableHttpError, RETRY_BACKOFF_MS } from "./client.js";

// -- isRetriableHttpError --------------------------------------------------

test("#855 retriable: ECONNREFUSED (daemon down, never reached)", () => {
    assert.equal(isRetriableHttpError({ code: "ECONNREFUSED" }), true);
});

test("#855 retriable: ENOENT (UDS path missing mid-restart)", () => {
    assert.equal(isRetriableHttpError({ code: "ENOENT" }), true);
});

test("#855 retriable: ECONNRESET (socket hang up by code)", () => {
    assert.equal(isRetriableHttpError({ code: "ECONNRESET" }), true);
});

test("#855 retriable: 'socket hang up' message (code-less node variants)", () => {
    assert.equal(
        isRetriableHttpError({ message: "POST /api/messages → socket hang up" }),
        true,
    );
});

test("#855 retriable: HTTP 502 / 503 / 504 transient server states", () => {
    assert.equal(isRetriableHttpError({ status: 502 }), true);
    assert.equal(isRetriableHttpError({ status: 503 }), true);
    assert.equal(isRetriableHttpError({ status: 504 }), true);
});

test("#855 NOT retriable: HTTP 4xx (deterministic client errors)", () => {
    assert.equal(isRetriableHttpError({ status: 400 }), false);
    assert.equal(isRetriableHttpError({ status: 401 }), false);
    assert.equal(isRetriableHttpError({ status: 403 }), false);
    assert.equal(isRetriableHttpError({ status: 404 }), false);
    assert.equal(isRetriableHttpError({ status: 409 }), false);
});

test("#855 NOT retriable: HTTP 500 / 501 / 505 (logic errors, not transient)", () => {
    assert.equal(isRetriableHttpError({ status: 500 }), false);
    assert.equal(isRetriableHttpError({ status: 501 }), false);
    assert.equal(isRetriableHttpError({ status: 505 }), false);
});

test("#855 NOT retriable: arbitrary throw / null / undefined", () => {
    assert.equal(isRetriableHttpError(null), false);
    assert.equal(isRetriableHttpError(undefined), false);
    assert.equal(isRetriableHttpError("string error"), false);
    assert.equal(isRetriableHttpError(new Error("random")), false);
});

// -- withRetry behavior ---------------------------------------------------

test("#855 withRetry: succeeds on first try when no error (no delay)", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
        calls++;
        return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(calls, 1);
});

test("#855 withRetry: retries on ECONNREFUSED and succeeds on attempt 2", async () => {
    let calls = 0;
    // Use very short delays for the test.
    const result = await withRetry(
        async () => {
            calls++;
            if (calls < 2) throw Object.assign(new Error("conn refused"), { code: "ECONNREFUSED" });
            return "ok-on-retry";
        },
        [1, 1, 1],
    );
    assert.equal(result, "ok-on-retry");
    assert.equal(calls, 2);
});

test("#855 withRetry: gives up after 4 attempts (1 initial + 3 retries)", async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(
            async () => {
                calls++;
                throw Object.assign(new Error("conn refused"), { code: "ECONNREFUSED" });
            },
            [1, 1, 1],
        ),
        /conn refused/,
    );
    assert.equal(calls, 4, "should attempt 4 times before giving up (initial + 3 backoff retries)");
});

test("#855 withRetry: 4xx propagates immediately, NO retry", async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(
            async () => {
                calls++;
                throw Object.assign(new Error("bad request"), { status: 400 });
            },
            [1, 1, 1],
        ),
        /bad request/,
    );
    assert.equal(calls, 1, "4xx is deterministic — must not retry");
});

test("#855 withRetry: arbitrary error propagates immediately, NO retry", async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(
            async () => {
                calls++;
                throw new Error("not a retriable shape");
            },
            [1, 1, 1],
        ),
        /not a retriable shape/,
    );
    assert.equal(calls, 1, "non-retriable errors propagate on the first attempt");
});

test("#855 withRetry: defaults to RETRY_BACKOFF_MS sequence (3 retries)", () => {
    assert.deepEqual(RETRY_BACKOFF_MS, [300, 1000, 3000]);
});
