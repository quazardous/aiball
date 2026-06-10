// #868 — RespawnState service unit tests.
// Run: `npx tsx --test src/claude-loop/respawn-state.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildRespawnEnv,
    buildRespawnEnvFromSnapshots,
    parseRespawnSnapshots,
    parseRespawnState,
    serializeRespawnSnapshots,
    serializeRespawnState,
    RESPAWN_STATE_ENV_VAR,
} from "./respawn-state.js";

test("serializeRespawnState: JSON shape, no extra fields", () => {
    const s = serializeRespawnState({ bootComplete: true });
    assert.equal(s, '{"bootComplete":true}');
});

test("parseRespawnState: undefined → null (no env var set)", () => {
    assert.equal(parseRespawnState(undefined), null);
});

test("parseRespawnState: empty string → null", () => {
    assert.equal(parseRespawnState(""), null);
});

test("parseRespawnState: malformed JSON → null (defensive)", () => {
    assert.equal(parseRespawnState("not-json"), null);
});

test("parseRespawnState: valid shape round-trips", () => {
    const s = serializeRespawnState({
        bootComplete: true,
        afkMode: "wait_10m",
        afkExpiryMs: 1_700_000_000_000,
    });
    const r = parseRespawnState(s);
    assert.deepEqual(r, { bootComplete: true, afkMode: "wait_10m", afkExpiryMs: 1_700_000_000_000 });
});

test("buildRespawnEnv: bootComplete=true → env contient le swap", () => {
    const env = buildRespawnEnv({ bootComplete: true }, { FOO: "bar" });
    assert.equal(env.FOO, "bar");
    assert.equal(env[RESPAWN_STATE_ENV_VAR], '{"bootComplete":true}');
});

test("buildRespawnEnv: rien à transférer → env baseline inchangé", () => {
    const baseline = { FOO: "bar" };
    const env = buildRespawnEnv({}, baseline);
    assert.equal(env[RESPAWN_STATE_ENV_VAR], undefined);
    assert.equal(env.FOO, "bar");
});

test("buildRespawnEnv: afkMode='off' seul (sans bootComplete) → env baseline", () => {
    const baseline = { FOO: "bar" };
    const env = buildRespawnEnv({ afkMode: "off", afkExpiryMs: null }, baseline);
    // afkMode "off" est la valeur par défaut — pas la peine de la transférer.
    assert.equal(env[RESPAWN_STATE_ENV_VAR], undefined);
});

test("buildRespawnEnv: afkMode='wait_10m' → env contient le swap", () => {
    const env = buildRespawnEnv(
        { afkMode: "wait_10m", afkExpiryMs: 1_700_000_000_000 },
        { FOO: "bar" },
    );
    assert.ok(env[RESPAWN_STATE_ENV_VAR]);
    const swap = JSON.parse(env[RESPAWN_STATE_ENV_VAR]!);
    assert.equal(swap.afkMode, "wait_10m");
    assert.equal(swap.afkExpiryMs, 1_700_000_000_000);
});

test("buildRespawnEnv: bootComplete + AFK ensemble", () => {
    const env = buildRespawnEnv(
        { bootComplete: true, afkMode: "wait_inf", afkExpiryMs: null },
        {},
    );
    const swap = JSON.parse(env[RESPAWN_STATE_ENV_VAR]!);
    assert.equal(swap.bootComplete, true);
    assert.equal(swap.afkMode, "wait_inf");
    assert.equal(swap.afkExpiryMs, null);
});

// #884 — Snapshot-based pattern.

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
