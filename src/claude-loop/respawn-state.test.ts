// #884 — RespawnSnapshots unit tests (legacy whitelist API retired
// dans `Go D`).
// Run: `npx tsx --test src/claude-loop/respawn-state.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildRespawnEnvFromSnapshots,
    parseRespawnSnapshots,
    serializeRespawnSnapshots,
    RESPAWN_STATE_ENV_VAR,
} from "./respawn-state.js";

test("serializeRespawnSnapshots: round-trip 5 controllers", () => {
    const snapshots = {
        boot: { value: "sealed", context: { deadlineMs: 12345 } },
        afk: { value: "off", context: { afkMode: "off" } },
        wake: { value: "idle", context: {} },
        typing: { value: "idle", context: {} },
        idle: { value: "idle", context: { idleSinceMs: 99999 } },
    };
    const raw = serializeRespawnSnapshots(snapshots);
    const parsed = parseRespawnSnapshots(raw);
    assert.deepEqual(parsed, snapshots);
});

test("parseRespawnSnapshots: undefined → null", () => {
    assert.equal(parseRespawnSnapshots(undefined), null);
});

test("parseRespawnSnapshots: malformed JSON → null", () => {
    assert.equal(parseRespawnSnapshots("not-json"), null);
});

test("buildRespawnEnvFromSnapshots: empty snapshots → baseEnv inchangé", () => {
    const baseEnv: NodeJS.ProcessEnv = { FOO: "bar" };
    const env = buildRespawnEnvFromSnapshots({}, baseEnv);
    assert.equal(env, baseEnv);
    assert.equal(env[RESPAWN_STATE_ENV_VAR], undefined);
});

test("buildRespawnEnvFromSnapshots: 1 snapshot → env contient swap", () => {
    const env = buildRespawnEnvFromSnapshots(
        { boot: { value: "sealed", context: {} } },
        { FOO: "bar" } as NodeJS.ProcessEnv,
    );
    assert.ok(env[RESPAWN_STATE_ENV_VAR]);
    const swap = JSON.parse(env[RESPAWN_STATE_ENV_VAR]!);
    assert.deepEqual(swap.boot, { value: "sealed", context: {} });
});

test("buildRespawnEnvFromSnapshots: round-trip via parse", () => {
    const snapshots = {
        boot: { value: "booting", context: { deadlineMs: 1000 } },
        afk: { value: "wait_10m", context: { afkMode: "wait_10m", afkExpiryMs: 5000 } },
    };
    const env = buildRespawnEnvFromSnapshots(snapshots, {} as NodeJS.ProcessEnv);
    const parsed = parseRespawnSnapshots(env[RESPAWN_STATE_ENV_VAR]);
    assert.deepEqual(parsed, snapshots);
});
