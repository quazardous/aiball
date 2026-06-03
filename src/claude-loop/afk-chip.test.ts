/**
 * #755 — `formatAfkStateChunk` unit tests. The win32 timer paints the
 * `@cl_afk_state` tmux chip from the central `computeLoopView` afkChunk
 * (the Rust proxy doesn't paint it, unlike the Unix Python proxy). These
 * pin the three rendered states against the Unix proxy's `_format_afk_state`
 * format, with the canonical seconds countdown (not the proxy's stale `9m`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAfkStateChunk } from "./state.js";
import type { AfkChunk } from "./loop-state.js";

const OPTS = { key: "F9", fgDim: "colour238", fgLit: "colour16" };

test("OFF (dim) → `AFK:F9`, dim label, no prefix", () => {
    const chunk: AfkChunk = { label: "AFK", prefix: null, color: "dim" };
    assert.equal(
        formatAfkStateChunk(chunk, OPTS),
        "#[fg=colour238]AFK:#[fg=colour16]F9",
    );
});

test("NOT AFK 10m (yellow) → seconds prefix + `NOT AFK:F9`, yellow", () => {
    const chunk: AfkChunk = { label: "NOT AFK", prefix: "260s", color: "yellow" };
    assert.equal(
        formatAfkStateChunk(chunk, OPTS),
        "#[fg=colour178]260s NOT AFK:#[fg=colour16]F9",
    );
});

test("NOT AFK ∞ (red) → `∞ NOT AFK:F9`, red", () => {
    const chunk: AfkChunk = { label: "NOT AFK", prefix: "∞", color: "red" };
    assert.equal(
        formatAfkStateChunk(chunk, OPTS),
        "#[fg=colour196]∞ NOT AFK:#[fg=colour16]F9",
    );
});

test("honors custom key + dim colour from env-derived opts", () => {
    const chunk: AfkChunk = { label: "AFK", prefix: null, color: "dim" };
    assert.equal(
        formatAfkStateChunk(chunk, { key: "F8", fgDim: "colour240", fgLit: "colour15" }),
        "#[fg=colour240]AFK:#[fg=colour15]F8",
    );
});
