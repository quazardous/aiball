// #3969 — the UI shows times in the board's zone when one is set, the browser's otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayKey, displayTimeZone, fmtDateTime, fmtTime } from "./time-zone";

const AT = "2026-10-13T22:30:00.000Z";

test("a zone set: times in it, whatever the browser's", () => {
    displayTimeZone.value = "Asia/Tokyo";
    assert.equal(dayKey(AT), "2026-10-14", "already the next day in Tokyo");
    assert.equal(fmtTime(AT, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), new Date(AT).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Tokyo" }));
    displayTimeZone.value = "UTC";
    assert.equal(dayKey(AT), "2026-10-13");
    assert.equal(fmtDateTime(AT), new Date(AT).toLocaleString(undefined, { timeZone: "UTC" }));
});

test("no zone set: the browser's, as before", () => {
    displayTimeZone.value = undefined;
    assert.equal(fmtDateTime(AT), new Date(AT).toLocaleString());
});
