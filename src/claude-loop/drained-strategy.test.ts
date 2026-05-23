// #379 — tests purs de la drained-strategy (parseur + décision). node:test,
// horloge injectée, aucun DB/timer. Couvre chaque stratégie + le reset au
// changement de landscape_hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    parseIsoDuration,
    parseDrainedStrategy,
    decideDrainedWake,
    DEFAULT_STALE_MS,
    DEFAULT_BACKOFF_BASE_MS,
    DEFAULT_BACKOFF_CAP_MS,
    type DrainedState,
    type DrainedStrategy,
} from "./drained-strategy.js";

const MIN = 60_000;
const H = 60 * MIN;

test("parseIsoDuration: PT forms", () => {
    assert.equal(parseIsoDuration("PT2H"), 2 * H);
    assert.equal(parseIsoDuration("PT10M"), 10 * MIN);
    assert.equal(parseIsoDuration("PT30M"), 30 * MIN);
    assert.equal(parseIsoDuration("PT1D"), 24 * H); // D toléré après T (david)
    assert.equal(parseIsoDuration("P1D"), 24 * H);
    assert.equal(parseIsoDuration("PT1H30M"), H + 30 * MIN);
    assert.equal(parseIsoDuration("PT45S"), 45_000);
    assert.equal(parseIsoDuration("garbage"), null);
    assert.equal(parseIsoDuration(""), null);
});

test("parseDrainedStrategy: bare names use defaults", () => {
    assert.deepEqual(parseDrainedStrategy("silent"), { kind: "silent" });
    assert.deepEqual(parseDrainedStrategy(""), { kind: "silent" });
    assert.deepEqual(parseDrainedStrategy(null), { kind: "silent" });
    assert.deepEqual(parseDrainedStrategy("once"), { kind: "once" });
    assert.deepEqual(parseDrainedStrategy("stale"), { kind: "stale", paramMs: DEFAULT_STALE_MS });
    assert.deepEqual(parseDrainedStrategy("backoff"), {
        kind: "backoff", paramMs: DEFAULT_BACKOFF_BASE_MS, capMs: DEFAULT_BACKOFF_CAP_MS,
    });
    assert.deepEqual(parseDrainedStrategy("persistent"), { kind: "persistent", paramMs: 0 });
});

test("parseDrainedStrategy: parametrized + case-insensitive", () => {
    assert.deepEqual(parseDrainedStrategy("stale:PT4H"), { kind: "stale", paramMs: 4 * H });
    assert.deepEqual(parseDrainedStrategy("backoff:PT5M"), {
        kind: "backoff", paramMs: 5 * MIN, capMs: DEFAULT_BACKOFF_CAP_MS,
    });
    assert.deepEqual(parseDrainedStrategy("backoff:PT5M/PT2H"), {
        kind: "backoff", paramMs: 5 * MIN, capMs: 2 * H,
    });
    assert.deepEqual(parseDrainedStrategy("persistent:PT30M"), { kind: "persistent", paramMs: 30 * MIN });
    assert.deepEqual(parseDrainedStrategy("STALE:pt2h"), { kind: "stale", paramMs: 2 * H });
});

test("parseDrainedStrategy: unknown / bad → silent (fail-safe)", () => {
    assert.deepEqual(parseDrainedStrategy("bogus"), { kind: "silent" });
    // bad duration falls back to the strategy default, not silent
    assert.deepEqual(parseDrainedStrategy("stale:nope"), { kind: "stale", paramMs: DEFAULT_STALE_MS });
});

test("decide silent: never wakes", () => {
    const s: DrainedStrategy = { kind: "silent" };
    const d = decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: null, now: 1000, prev: null });
    assert.equal(d.wake, false);
    assert.equal(d.next.hash, "a");
});

test("decide once: fires at vidange, then silent, re-arms on hash change", () => {
    const s: DrainedStrategy = { kind: "once" };
    // 1er passage : fire.
    const d1 = decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: null, now: 1000, prev: null });
    assert.equal(d1.wake, true);
    // même hash → silence.
    const d2 = decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: null, now: 2000, prev: d1.next });
    assert.equal(d2.wake, false);
    // le paysage bouge → ré-arme.
    const d3 = decideDrainedWake({ strategy: s, hash: "b", lastActivityMs: null, now: 3000, prev: d2.next });
    assert.equal(d3.wake, true);
});

test("decide stale: silent until stale, fires once, even when hash unchanged", () => {
    const s: DrainedStrategy = { kind: "stale", paramMs: 2 * H };
    const t0 = 10 * H;
    // activité il y a 1h < seuil 2h → pas stale.
    let prev: DrainedState | null = null;
    const fresh = decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: t0 - 1 * H, now: t0, prev });
    assert.equal(fresh.wake, false);
    prev = fresh.next;
    // 2h plus tard, MÊME hash, activité toujours à t0-1h → now - act = 3h > 2h → stale → fire.
    const stale = decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: t0 - 1 * H, now: t0 + 2 * H, prev });
    assert.equal(stale.wake, true);
    prev = stale.next;
    // tick suivant, toujours stale, hash inchangé → pas de re-ping (auto-mémo une fois).
    const again = decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: t0 - 1 * H, now: t0 + 3 * H, prev });
    assert.equal(again.wake, false);
});

test("decide stale: human acts (hash changes) → re-arms", () => {
    const s: DrainedStrategy = { kind: "stale", paramMs: 2 * H };
    const t0 = 100 * H;
    const fired = decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: t0 - 3 * H, now: t0, prev: null });
    assert.equal(fired.wake, true);
    // humain agit : hash change + activité fraîche → pas stale, ré-armé.
    const acted = decideDrainedWake({ strategy: s, hash: "b", lastActivityMs: t0, now: t0 + MIN, prev: fired.next });
    assert.equal(acted.wake, false);
});

test("decide backoff: gaps base, 2x, 4x ; reset on hash change", () => {
    const base = 30 * MIN;
    const s: DrainedStrategy = { kind: "backoff", paramMs: base, capMs: DEFAULT_BACKOFF_CAP_MS };
    const t0 = 1_000_000;
    let prev: DrainedState | null = null;

    // vidange : pas de fire immédiat.
    const v = decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: null, now: t0, prev });
    assert.equal(v.wake, false);
    prev = v.next;

    // juste avant +base → non ; à +base → fire (1er rappel).
    assert.equal(decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: null, now: t0 + base - 1, prev }).wake, false);
    const r1 = decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: null, now: t0 + base, prev });
    assert.equal(r1.wake, true);
    assert.equal(r1.next.step, 1);
    prev = r1.next;

    // 2e rappel : gap = 2·base après le 1er.
    const t1 = t0 + base;
    assert.equal(decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: null, now: t1 + 2 * base - 1, prev }).wake, false);
    const r2 = decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: null, now: t1 + 2 * base, prev });
    assert.equal(r2.wake, true);
    assert.equal(r2.next.step, 2);
    prev = r2.next;

    // 3e rappel : gap = 4·base.
    const t2 = t1 + 2 * base;
    const r3 = decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: null, now: t2 + 4 * base, prev });
    assert.equal(r3.wake, true);
    assert.equal(r3.next.step, 3);
    prev = r3.next;

    // le paysage bouge → reset (step 0, ré-armé, pas de fire immédiat).
    const reset = decideDrainedWake({ strategy: s, hash: "b", lastActivityMs: null, now: t2 + 4 * base + 10, prev });
    assert.equal(reset.wake, false);
    assert.equal(reset.next.step, 0);
});

test("decide backoff: interval capped", () => {
    const base = 10 * MIN;
    const cap = 1 * H;
    const s: DrainedStrategy = { kind: "backoff", paramMs: base, capMs: cap };
    // step assez grand pour dépasser le cap : interval = cap.
    const prev: DrainedState = { hash: "a", armedAt: 0, wakeAt: 0, step: 20 };
    // à cap-1 → pas de fire ; à cap → fire.
    assert.equal(decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: null, now: cap - 1, prev }).wake, false);
    assert.equal(decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: null, now: cap, prev }).wake, true);
});

test("decide persistent: every tick when no spacing", () => {
    const s: DrainedStrategy = { kind: "persistent", paramMs: 0 };
    const a = decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: null, now: 1000, prev: null });
    assert.equal(a.wake, true);
    const b = decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: null, now: 1001, prev: a.next });
    assert.equal(b.wake, true);
});

test("decide persistent: respects spacing", () => {
    const s: DrainedStrategy = { kind: "persistent", paramMs: 30 * MIN };
    const a = decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: null, now: 1000, prev: null });
    assert.equal(a.wake, true);
    // avant l'espacement → non.
    assert.equal(decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: null, now: 1000 + 30 * MIN - 1, prev: a.next }).wake, false);
    // après → oui.
    assert.equal(decideDrainedWake({ strategy: s, hash: "a", lastActivityMs: null, now: 1000 + 30 * MIN, prev: a.next }).wake, true);
});
