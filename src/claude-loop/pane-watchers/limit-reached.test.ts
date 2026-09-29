// #3268 — Claude Code's usage-limit banner: recognised by its shape at the foot of the screen, never by a quote; its reset read when it is a delay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LimitReachedWatcher, limitResetsOf } from "./runtime-watchers.js";

const screen = (footer: string, above = "some output\nmore output") => `${above}\n\n${footer}\n`;
const scan = (text: string) => {
    const w = new LimitReachedWatcher();
    w.observe(text, { isBoot: false } as never);
    return { on: w.snapshot().visible, banner: w.banner() };
};

test("the banners that stop Claude: weekly, session, 5-hour, Opus, the monthly spend limit", () => {
    for (const b of [
        "You've hit your weekly limit · resets in 3h 20m",
        "You've hit your session limit · resets 11pm (Europe/Paris)",
        "You've hit your 5-hour limit",
        "You've hit your Opus limit · resets Oct 3, 9am",
        "You've hit your monthly spend limit · your Team resets Oct 1",
    ]) assert.equal(scan(screen(b)).on, true, b);
});

test("not the fast mode's limit, not the NN% warning, not a quote in a prompt or up the screen", () => {
    assert.equal(scan(screen("You've hit your fast limit · resets in 20m")).on, false, "fast mode falls back on its own");
    assert.equal(scan(screen("You've used 88% of your weekly limit · resets in 2d")).on, false, "a warning");
    assert.equal(scan(screen("> #3268: You've hit your weekly limit → tenir la loop")).on, false, "a wake phrase quoting it");
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    assert.equal(scan(`You've hit your weekly limit\n${long}\n❯ \n`).on, false, "far up the screen: not the footer");
});

test("the reset: a delay becomes a moment; a clock time or a date stays text", () => {
    const now = Date.parse("2026-09-28T16:00:00.000Z");
    assert.deepEqual(limitResetsOf("You've hit your weekly limit · resets in 3h 20m", now), { text: "in 3h 20m", at: "2026-09-28T19:20:00.000Z" });
    assert.deepEqual(limitResetsOf("… resets in 45m", now), { text: "in 45m", at: "2026-09-28T16:45:00.000Z" });
    assert.deepEqual(limitResetsOf("… resets in 2d", now), { text: "in 2d", at: "2026-09-30T16:00:00.000Z" });
    assert.deepEqual(limitResetsOf("… resets 11pm (Europe/Paris)", now), { text: "11pm (Europe/Paris)", at: null });
    assert.equal(limitResetsOf("You've hit your 5-hour limit", now), null);
});
