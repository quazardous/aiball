import { test } from "node:test";
import assert from "node:assert/strict";
import { modelShortName } from "./model-name.js";

test("a model id reads as its family and version", () => {
    assert.equal(modelShortName("claude-opus-5-5"), "Opus 5.5");
    assert.equal(modelShortName("claude-sonnet-4-6"), "Sonnet 4.6");
    assert.equal(modelShortName("claude-opus-5"), "Opus 5");
    assert.equal(modelShortName("claude-fable-5-1"), "Fable 5.1");
});

test("a release date is dropped, a context tag kept", () => {
    assert.equal(modelShortName("claude-haiku-4-5-20251001"), "Haiku 4.5");
    assert.equal(modelShortName("claude-opus-5-5[1m]"), "Opus 5.5 (1M)");
});

test("the older order, version first, reads the same way", () => {
    assert.equal(modelShortName("claude-3-5-sonnet-20241022"), "Sonnet 3.5");
});

test("an id it does not recognise stays as it is", () => {
    assert.equal(modelShortName("<synthetic>"), "<synthetic>");
    assert.equal(modelShortName("gpt-x.1"), "gpt-x.1");
    assert.equal(modelShortName("claude-4-5"), "claude-4-5");
});
