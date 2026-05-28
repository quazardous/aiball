import { test } from "node:test";
import assert from "node:assert/strict";
import { compareWorkOrder, isWithinHotWindow, computeHotFocus, type WorkOrderCtx } from "./work-order.js";

const WEIGHT: Record<string, number> = { urgent: 4, high: 3, normal: 2, low: 1 };
const pw = (p: string | null | undefined): number => WEIGHT[p ?? "normal"] ?? 2;

/** Build a ctx from plain maps for terse tests. */
function ctx(tiers: Record<number, number>, hot: Set<number>): WorkOrderCtx {
    return { tierOf: (id) => tiers[id] ?? 2, priorityWeight: pw, isHot: (id) => hot.has(id) };
}

function sorted(rows: { id: number; priority?: string | null }[], c: WorkOrderCtx): number[] {
    return [...rows].sort((a, b) => compareWorkOrder(a, b, c)).map((r) => r.id);
}

test("#371 tier dominates priority and hot", () => {
    // 1 is open(tier2) urgent+hot; 2 is actionable(tier1) low cold → 2 first (tier wins).
    const c = ctx({ 1: 2, 2: 1 }, new Set([1]));
    assert.deepEqual(sorted([{ id: 1, priority: "urgent" }, { id: 2, priority: "low" }], c), [2, 1]);
});

test("#xkehmv priority is the strongest sort WITHIN a tier (beats hot)", () => {
    // same tier: 1 normal+hot, 2 urgent cold → urgent first (priority > hot).
    const c = ctx({ 1: 1, 2: 1 }, new Set([1]));
    assert.deepEqual(sorted([{ id: 1, priority: "normal" }, { id: 2, priority: "urgent" }], c), [2, 1]);
});

test("#402 hot breaks ties at EQUAL priority (within a tier)", () => {
    // same tier, same priority: 2 hot, 1 cold → 2 first.
    const c = ctx({ 1: 1, 2: 1 }, new Set([2]));
    assert.deepEqual(sorted([{ id: 1, priority: "normal" }, { id: 2, priority: "normal" }], c), [2, 1]);
});

test("#371 oldest (id asc) is the final tiebreak when all else equal", () => {
    const c = ctx({ 5: 1, 9: 1 }, new Set());
    assert.deepEqual(sorted([{ id: 9, priority: "normal" }, { id: 5, priority: "normal" }], c), [5, 9]);
});

test("#402 hot stays within its tier — a hot open ticket never jumps actionable", () => {
    // 1 actionable(tier1) cold, 2 open(tier2) hot → 1 first (tier beats hot).
    const c = ctx({ 1: 1, 2: 2 }, new Set([2]));
    assert.deepEqual(sorted([{ id: 1, priority: "normal" }, { id: 2, priority: "normal" }], c), [1, 2]);
});

test("#430 own claim beats hot at EQUAL priority within a tier", () => {
    // same tier, same priority: 1 hot, 2 own-claim → 2 first (claim > hot).
    const c: WorkOrderCtx = { tierOf: () => 1, priorityWeight: pw, isHot: (id) => id === 1, isOwnClaim: (id) => id === 2 };
    assert.deepEqual(sorted([{ id: 1, priority: "normal" }, { id: 2, priority: "normal" }], c), [2, 1]);
});

test("#430 priority still beats own claim within a tier", () => {
    // 1 normal+own-claim, 2 urgent → urgent first (priority is the strongest sort).
    const c: WorkOrderCtx = { tierOf: () => 1, priorityWeight: pw, isHot: () => false, isOwnClaim: (id) => id === 1 };
    assert.deepEqual(sorted([{ id: 1, priority: "normal" }, { id: 2, priority: "urgent" }], c), [2, 1]);
});

test("#430 own claim stays within its tier (never jumps unread/actionable)", () => {
    // 1 actionable(tier1) cold, 2 open(tier2) own-claim → 1 first (tier beats claim).
    const c: WorkOrderCtx = { tierOf: (id) => (id === 1 ? 1 : 2), priorityWeight: pw, isHot: () => false, isOwnClaim: (id) => id === 2 };
    assert.deepEqual(sorted([{ id: 1, priority: "normal" }, { id: 2, priority: "normal" }], c), [1, 2]);
});

test("#430 isOwnClaim omitted → no claim distinction (back-compat)", () => {
    // legacy ctx (no isOwnClaim) → falls through to hot then oldest.
    const c = ctx({ 1: 1, 2: 1 }, new Set([2]));
    assert.deepEqual(sorted([{ id: 1, priority: "normal" }, { id: 2, priority: "normal" }], c), [2, 1]);
});

test("#436(4) assigned-to-me beats hot, below own-claim", () => {
    // same tier+priority. 1 hot, 2 assigned-to-me → 2 first (assignment > hot).
    const c1: WorkOrderCtx = { tierOf: () => 1, priorityWeight: pw, isHot: (id) => id === 1, isAssignedToMe: (id) => id === 2 };
    assert.deepEqual(sorted([{ id: 1, priority: "normal" }, { id: 2, priority: "normal" }], c1), [2, 1]);
    // 1 own-claim, 2 assigned-to-me → 1 first (own-claim outranks assignment).
    const c2: WorkOrderCtx = { tierOf: () => 1, priorityWeight: pw, isHot: () => false, isOwnClaim: (id) => id === 1, isAssignedToMe: (id) => id === 2 };
    assert.deepEqual(sorted([{ id: 1, priority: "normal" }, { id: 2, priority: "normal" }], c2), [1, 2]);
});

test("#532 computeHotFocus: multi-hot — every ticket within the window is hot (no mono-focus reduction)", () => {
    const now = Date.parse("2026-05-24T10:00:00Z");
    const win = 600_000; // 10 min
    const self = new Map<number, string>([
        [1, "2026-05-24T09:58:00Z"], // 2 min ago — in
        [2, "2026-05-24T09:50:00Z"], // 10 min ago (== window edge → out)
        [3, "2026-05-24T09:59:30Z"], // 30 s ago — in
        [4, "2026-05-24T09:55:00Z"], // 5 min ago — in
    ]);
    const focus = computeHotFocus(self, now, win);
    assert.deepEqual([...focus].sort((a, b) => a - b), [1, 3, 4]);
});

test("#405 computeHotFocus: empty when nothing is within the window", () => {
    const now = Date.parse("2026-05-24T10:00:00Z");
    const self = new Map<number, string>([[1, "2026-05-24T09:00:00Z"]]); // 1h ago
    assert.equal(computeHotFocus(self, now, 600_000).size, 0);
    assert.equal(computeHotFocus(new Map(), now, 600_000).size, 0);
});

test("#402 isWithinHotWindow", () => {
    const now = Date.parse("2026-05-24T10:00:00Z");
    const win = 600_000; // 10 min
    assert.equal(isWithinHotWindow("2026-05-24T09:55:00Z", now, win), true); // 5 min ago
    assert.equal(isWithinHotWindow("2026-05-24T09:45:00Z", now, win), false); // 15 min ago
    assert.equal(isWithinHotWindow(null, now, win), false);
    assert.equal(isWithinHotWindow(undefined, now, win), false);
    assert.equal(isWithinHotWindow("not-a-date", now, win), false);
});
