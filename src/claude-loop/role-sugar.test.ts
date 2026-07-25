/**
 * #1435 slice 1 — role sugar. A `consumer.role` in `.aiball.yaml` (or the
 * `--role` CLI flag, which overrides it the same way) maps onto existing
 * primitives: crew ⇒ no_claim forced true (assignment-only); lead / unset ⇒
 * no_claim false (owner + can-claim, today's default). Verified through the
 * config → project-context derivation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { loadConfig } = await import("../autopoll/config.js");
const { resolveProjectContext } = await import("./project-context.js");

function projectDir(role: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "aiball-1435-"));
    const roleLine = role ? `\n  role: ${role}` : "";
    writeFileSync(
        join(dir, ".aiball.yaml"),
        `consumer:\n  agent: worker-1\n  project: demo${roleLine}\n`,
    );
    return dir;
}

test("consumer.role: crew is read from .aiball.yaml", () => {
    const cfg = loadConfig(projectDir("crew"));
    assert.equal(cfg.consumer.role, "crew");
});

test("crew role forces no_claim in the resolved context", () => {
    const ctx = resolveProjectContext({ cwd: projectDir("crew") });
    assert.equal(ctx.role, "crew");
    assert.equal(ctx.no_claim, true);
});

test("lead role keeps no_claim false (owner + can-claim)", () => {
    const ctx = resolveProjectContext({ cwd: projectDir("lead") });
    assert.equal(ctx.role, "lead");
    assert.equal(ctx.no_claim, false);
});

test("no role = solo default (role null, no_claim false)", () => {
    const ctx = resolveProjectContext({ cwd: projectDir(null) });
    assert.equal(ctx.role, null);
    assert.equal(ctx.no_claim, false);
});

test("an unknown role value is ignored (stays null)", () => {
    const cfg = loadConfig(projectDir("captain"));
    assert.equal(cfg.consumer.role, null);
});
