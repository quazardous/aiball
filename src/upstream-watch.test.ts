// #1566 — the watch decision. What matters here is what it does NOT do:
// no announcement on the first sight, none when nothing moved, and none on a
// malformed remote timestamp. A false "updated upstream" is worse than a
// missed one — it trains the reader to ignore the notice.
//
// Run: `npx tsx --test src/upstream-watch.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
    decideWatch,
    excerpt,
    formatUpstreamNotice,
    isSystemActor,
    UPSTREAM_ACTOR,
} from "./upstream-watch.js";
import type { ExternalIssue } from "./upstream-providers.js";

const issue = (over: Partial<ExternalIssue> = {}): ExternalIssue => ({
    num: 86,
    title: "release: publish the proxy binaries from CI",
    body: "body text",
    state: "open",
    labels: [],
    url: "https://github.com/o/r/issues/86",
    updatedAt: "2026-07-26T10:00:00Z",
    ...over,
});

test("first sight arms the watermark WITHOUT announcing", () => {
    const d = decideWatch({ seenAt: null }, issue());
    assert.equal(d.kind, "adopt");
    // Shipping this would otherwise announce every long-coupled ticket at once,
    // for changes nobody is waiting to hear about.
    assert.equal(d.kind === "adopt" && d.seenAt, "2026-07-26T10:00:00Z");
});

test("an unchanged remote produces no event at all", () => {
    assert.equal(decideWatch({ seenAt: "2026-07-26T10:00:00Z" }, issue()).kind, "unchanged");
});

test("an older remote timestamp is not a change either", () => {
    const d = decideWatch({ seenAt: "2026-07-26T12:00:00Z" }, issue());
    assert.equal(d.kind, "unchanged");
});

test("a newer remote timestamp is the one case that speaks", () => {
    const d = decideWatch({ seenAt: "2026-07-26T10:00:00Z" }, issue({ updatedAt: "2026-07-26T10:00:01Z" }));
    assert.equal(d.kind, "changed");
    assert.equal(d.kind === "changed" && d.seenAt, "2026-07-26T10:00:01Z");
});

test("a missing or malformed remote timestamp stays silent rather than guessing", () => {
    assert.equal(decideWatch({ seenAt: "2026-07-26T10:00:00Z" }, issue({ updatedAt: null })).kind, "unchanged");
    assert.equal(decideWatch({ seenAt: null }, issue({ updatedAt: undefined })).kind, "unchanged");
});

test("a closure names who did it — free in the payload, no extra call", () => {
    const text = formatUpstreamNotice("gh#86", issue({ state: "closed", closedBy: "quazardous" }));
    assert.match(text, /was \*\*closed\*\* by \*\*quazardous\*\*/);
    assert.match(text, /issues\/86/);
});

test("a plain update names nobody rather than inventing an attribution", () => {
    const text = formatUpstreamNotice("gh#86", issue());
    assert.match(text, /changed/);
    assert.doesNotMatch(text, /by \*\*/);
});

test("the notice quotes, it does not mirror", () => {
    const long = "x".repeat(400);
    const text = formatUpstreamNotice("gh#86", issue({ title: long }));
    assert.ok(text.length < 300, "a notice that reproduces the issue is a copy by another name");
    assert.match(text, /…/);
});

test("excerpt flattens newlines so the quote stays one line", () => {
    assert.equal(excerpt("a\n\n  b   c "), "a b c");
    assert.equal(excerpt(null), "");
});

test("the system actor is recognisable by prefix alone", () => {
    assert.equal(UPSTREAM_ACTOR, "__system:upstream");
    assert.equal(isSystemActor(UPSTREAM_ACTOR), true);
    assert.equal(isSystemActor("claude-aiball-dev"), false);
    assert.equal(isSystemActor(null), false);
    // The point of the prefix: a listing filters machine identities with one
    // test, instead of maintaining a list of known system ids.
    assert.equal(isSystemActor("__system:cron"), true);
});
