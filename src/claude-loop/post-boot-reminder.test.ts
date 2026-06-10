/**
 * #848 Slice 1 — `post_boot_skill_reminder` slot contract test.
 *
 * Validates that the shipped default `config/defaults/claude-loop-pings.yaml`
 * carries a non-empty `prompts.post_boot_skill_reminder` slot, and that a
 * per-project override flips it off cleanly (= opt-out by setting to "").
 * The actual wiring inside `timer.ts:onFreshBootSeal` (#872 Phase 3 :
 * ex-`performBootSeal`) is exercised in the integration scenarios —
 * this is the pure contract on the prompt-template layer that the seal
 * subscriber consumes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
    loadPromptsFromYaml,
    loadPromptsFromYamlBlock,
    renderSlot,
} from "../prompt-templates.js";

const REPO_ROOT = join(import.meta.dirname, "../..");
const DEFAULTS_YAML = join(REPO_ROOT, "config/defaults/claude-loop-pings.yaml");

test("#848 defaults: post_boot_skill_reminder slot is present and non-empty", () => {
    const map = loadPromptsFromYaml(DEFAULTS_YAML);
    const rendered = renderSlot(map, "post_boot_skill_reminder", {}, "");
    assert.ok(
        rendered.length > 0,
        "expected non-empty default reminder; got empty (slot missing or value empty)",
    );
    assert.ok(
        rendered.toLowerCase().includes("aiball"),
        `expected default reminder to mention "aiball"; got: ${rendered.slice(0, 120)}`,
    );
});

test("#848 override: setting post_boot_skill_reminder to empty string opts out", () => {
    const map = loadPromptsFromYamlBlock({
        post_boot_skill_reminder: "",
    });
    const rendered = renderSlot(map, "post_boot_skill_reminder", {}, "");
    assert.equal(
        rendered,
        "",
        "an empty-string override should render to empty (= no injection at boot exit)",
    );
});

test("#848 override: custom reminder takes precedence over default", () => {
    const map = loadPromptsFromYamlBlock({
        post_boot_skill_reminder: "Custom project-specific reminder.",
    });
    const rendered = renderSlot(map, "post_boot_skill_reminder", {}, "");
    assert.equal(rendered, "Custom project-specific reminder.");
});

test("#848 slot missing entirely: renderSlot falls back to provided fallback", () => {
    const map = loadPromptsFromYamlBlock({});
    const rendered = renderSlot(map, "post_boot_skill_reminder", {}, "");
    assert.equal(
        rendered,
        "",
        "an absent slot should fall back to the empty fallback (caller treats as opt-out)",
    );
});
