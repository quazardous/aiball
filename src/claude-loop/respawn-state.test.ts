// #868 — RespawnState service unit tests.
// Run: `npx tsx --test src/claude-loop/respawn-state.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildRespawnEnv,
    parseRespawnState,
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
