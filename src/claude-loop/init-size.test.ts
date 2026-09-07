/**
 * The contract with `cl-pty-proxy`.
 *
 * These bounds are duplicated in Rust (`core.rs::parse_size`) because the two
 * sides are built and shipped separately: the proxy is a release artifact, not
 * something a `npm i` rebuilds. So a value this side is willing to send but
 * that side refuses would silently degrade back to the reflow, with nothing to
 * observe. Pinning the exact edges on both sides is what keeps them honest.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveInitSize, formatInitSize } from "./init-size.js";

test("a real terminal yields the rows,cols the proxy parses", () => {
    assert.equal(resolveInitSize(200, 50), "50,200");
    assert.equal(formatInitSize(50, 200), "50,200");
});

test("no terminal is a normal outcome, not an error", () => {
    // `process.stdout.columns` is undefined off a TTY — a piped start, a
    // service, a test runner. The proxy must fall back to probing, so we send
    // nothing rather than a guess.
    assert.equal(resolveInitSize(undefined, undefined), null);
    assert.equal(resolveInitSize(200, undefined), null);
    assert.equal(resolveInitSize(undefined, 50), null);
});

test("a geometry openpty would choke on is never sent", () => {
    for (const [c, r] of [[0, 50], [200, 0], [-1, 50], [200, -1], [2001, 50], [200, 2001]]) {
        assert.equal(resolveInitSize(c, r), null, `${c}x${r} must be refused`);
    }
});

test("non-integers are refused rather than rounded", () => {
    // A rounded value is a guess wearing the costume of a measurement.
    assert.equal(resolveInitSize(199.5, 50), null);
    assert.equal(resolveInitSize(NaN, 50), null);
});

test("the bounds match what core.rs::parse_size accepts", () => {
    // Same edges, both sides: 1 and 2000 in, 0 and 2001 out.
    assert.equal(resolveInitSize(1, 1), "1,1");
    assert.equal(resolveInitSize(2000, 2000), "2000,2000");
    assert.equal(resolveInitSize(2001, 2000), null);
});
