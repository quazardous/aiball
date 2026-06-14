// #962 — `formatAfkGlyph` pure mapping tests : AfkChunk → tmux glyph string.
import { test } from "node:test";
import assert from "node:assert/strict";

import { formatAfkGlyph } from "./state.js";

test("AFK off (autonomous, color dim) → gris foncé, no suffix", () => {
    assert.equal(
        formatAfkGlyph({ color: "dim", prefix: null }),
        " #[fg=colour238,bg=colour16]웃",
    );
});

test("NOT AFK ∞ (held indef, color red) → rouge + ∞", () => {
    assert.equal(
        formatAfkGlyph({ color: "red", prefix: "∞" }),
        " #[fg=colour196,bg=colour16]웃∞",
    );
});

test("NOT AFK 10m (held countdown, color yellow) → orange + Ns", () => {
    assert.equal(
        formatAfkGlyph({ color: "yellow", prefix: "260s" }),
        " #[fg=colour178,bg=colour16]웃260s",
    );
});

test("leading space included so the glyph stays compact in the template", () => {
    // Le caller (`@cl_afk_glyph`) interpole directement la string sans
    // padding — le leading space évite qu'elle colle au précédent token
    // (`#{@cl_state}`).
    assert.ok(formatAfkGlyph({ color: "dim", prefix: null }).startsWith(" "));
});
