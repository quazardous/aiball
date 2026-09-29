import { test } from "node:test";
import assert from "node:assert/strict";
import { paginateFeed } from "./feed-paginate.js";

// #396: pagination + order on the full thread feed (pure helper).
const feed = [1, 2, 3, 4, 5];

test("#396 paginate: no params → untouched feed, no pagination block", () => {
    const r = paginateFeed(feed, {});
    assert.deepEqual(r.feed, [1, 2, 3, 4, 5]);
    assert.equal(r.pagination, undefined);
});

test("#396 paginate: order=asc is the natural order (oldest-first)", () => {
    const r = paginateFeed(feed, { order: "asc", limit: "2" });
    assert.deepEqual(r.feed, [1, 2]);
    assert.deepEqual(r.pagination, {
        offset: 0,
        limit: 2,
        returned: 2,
        total: 5,
        order: "asc",
        has_more: true,
    });
});

test("#396 paginate: order=desc + limit=N → N most recent (newest-first)", () => {
    const r = paginateFeed(feed, { order: "desc", limit: "2" });
    assert.deepEqual(r.feed, [5, 4]);
    assert.deepEqual(r.pagination, {
        offset: 0,
        limit: 2,
        returned: 2,
        total: 5,
        order: "desc",
        has_more: true,
    });
});

test("#396 paginate: offset skips, has_more flips at the end", () => {
    const r = paginateFeed(feed, { offset: "3", limit: "10" });
    assert.deepEqual(r.feed, [4, 5]);
    assert.equal(r.pagination?.offset, 3);
    assert.equal(r.pagination?.has_more, false);
});

test("#396 paginate: offset alone (no limit) paginates from offset to end", () => {
    const r = paginateFeed(feed, { offset: "2" });
    assert.deepEqual(r.feed, [3, 4, 5]);
    assert.equal(r.pagination?.limit, null);
    assert.equal(r.pagination?.has_more, false);
});

test("#396 paginate: garbage / non-positive params are ignored (no-op)", () => {
    assert.equal(paginateFeed(feed, { offset: "-1", limit: "0" }).pagination, undefined);
    assert.equal(paginateFeed(feed, { limit: "abc" }).pagination, undefined);
    assert.deepEqual(paginateFeed(feed, { offset: ["1"] as unknown }).feed, [1, 2, 3, 4, 5]);
});
