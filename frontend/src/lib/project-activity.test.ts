// #3132 — the project pickers: active is a loop or recent activity, ordered by
// activity, never fewer than MIN_ACTIVE; the rest by name.
import test from "node:test";
import assert from "node:assert/strict";
import { ACTIVE_DAYS, MIN_ACTIVE, isProjectActive, splitProjects } from "./project-activity";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();
const p = (name: string, age: number | null, running = false) => ({ value: name, label: name, running, last_activity: age === null ? null : daysAgo(age) });
const names = (xs: { value: string | null }[]) => xs.map((x) => x.value);

test("active: a loop runs on it, or it moved within ACTIVE_DAYS; a waiting count no longer counts", () => {
    assert.equal(isProjectActive(p("a", 0.5), NOW), true);
    assert.equal(isProjectActive(p("b", ACTIVE_DAYS + 0.1), NOW), false);
    assert.equal(isProjectActive(p("c", 60, true), NOW), true, "a running loop, however old");
    assert.equal(isProjectActive({ ...p("d", 12), pending: 9 } as ReturnType<typeof p>, NOW), false, "pending alone keeps nothing up");
    assert.equal(isProjectActive(p("e", null), NOW), false);
});

test("the active group: running loops first, then the most recent; the rest by name", () => {
    const items = [
        { value: null, label: "All projects" },
        p("zeta", 0.1), p("alpha", 40), p("nelson", 5, true), p("tvty", 0.01, true),
        p("mid", 1), p("beta", 2.5), p("old", 50), p("gamma", 30),
    ];
    const { active, inactive } = splitProjects(items, null, NOW);
    assert.deepEqual(names(active), ["tvty", "nelson", "zeta", "mid", "beta"]);
    assert.deepEqual(names(inactive), ["alpha", "gamma", "old"]);
});

test(`never fewer than ${MIN_ACTIVE}: on a quiet stretch the most recent fill the group`, () => {
    const items = [p("a", 10), p("b", 20), p("c", 4), p("d", 90), p("e", 6), p("f", 30), p("g", null)];
    const { active, inactive } = splitProjects(items, null, NOW);
    assert.deepEqual(names(active), ["c", "e", "a", "b", "f"]);
    assert.deepEqual(names(inactive), ["d", "g"]);
    assert.equal(splitProjects([p("x", 50), p("y", 60)], null, NOW).active.length, 2, "fewer projects than that: all of them");
});

test("the selected project stays in view, in its place by activity", () => {
    const items = [p("a", 0.1), p("b", 0.2), p("c", 0.3), p("d", 0.4), p("e", 0.5), p("quiet", 80)];
    const { active, inactive } = splitProjects(items, "quiet", NOW);
    assert.deepEqual(names(active), ["a", "b", "c", "d", "e", "quiet"]);
    assert.deepEqual(names(inactive), []);
});
