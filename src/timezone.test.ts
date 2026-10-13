// #3969 — the board's times in its zone, for agents and the UI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatZoned, isTimeZoneSetting, resolveTimeZone, rewriteTimes, timeZoneNote, toUtcIso, toZoneIso, zoneAbbrev } from "./timezone.js";

const AT = "2026-10-13T10:44:47.774Z";
const MS = Date.parse(AT);

test("a UTC time in Paris keeps its instant and says its offset", () => {
    assert.equal(toZoneIso(AT, "Europe/Paris"), "2026-10-13T12:44:47.774+02:00");
    assert.equal(Date.parse(toZoneIso(AT, "Europe/Paris")), MS, "same instant");
    assert.equal(toZoneIso("2026-01-13T10:44:47Z", "Europe/Paris"), "2026-01-13T11:44:47+01:00", "winter time");
    assert.equal(toZoneIso(AT, "Asia/Kolkata"), "2026-10-13T16:14:47.774+05:30");
    assert.equal(toZoneIso(AT, "America/New_York"), "2026-10-13T06:44:47.774-04:00");
    assert.equal(toZoneIso("2026-10-13T00:30:00.000Z", "America/New_York"), "2026-10-12T20:30:00.000-04:00", "the day changes too");
});

test("in UTC, times stay `…Z`; what is not a UTC time is left alone", () => {
    assert.equal(toZoneIso(AT, "UTC"), AT);
    for (const v of ["2026-10-13", "12:44", "not a date", "2026-10-13T12:44:47+02:00"]) assert.equal(toZoneIso(v, "Europe/Paris"), v);
});

test("an agent's time with an offset goes back to UTC; anything else is left alone", () => {
    assert.equal(toUtcIso("2026-10-13T12:44:47.774+02:00"), AT);
    assert.equal(toUtcIso("2026-10-13T12:44+02:00"), "2026-10-13T10:44:00.000Z");
    assert.equal(toUtcIso(AT), AT);
    assert.equal(toUtcIso("1h"), "1h");
});

test("a payload is rewritten deep, its other values kept", () => {
    const out = rewriteTimes({ id: 7, created_at: AT, title: AT + " in a title", meta: { list: [AT, 3, null] }, ok: true }, "Europe/Paris");
    assert.deepEqual(out, {
        id: 7, created_at: "2026-10-13T12:44:47.774+02:00", title: AT + " in a title",
        meta: { list: ["2026-10-13T12:44:47.774+02:00", 3, null] }, ok: true,
    });
});

test("zones are named the way a reader knows them", () => {
    assert.equal(zoneAbbrev(MS, "Europe/Paris"), "CEST");
    assert.equal(zoneAbbrev(MS, "America/New_York"), "EDT");
    assert.equal(zoneAbbrev(MS, "UTC"), "UTC");
    assert.equal(zoneAbbrev(MS, "Asia/Kolkata"), "UTC+05:30", "no short name: the offset");
    assert.equal(formatZoned(MS, "Europe/Paris"), "2026-10-13 12:44 CEST");
    assert.match(timeZoneNote("Europe/Paris", MS), /^Times are in Europe\/Paris \(CEST, UTC\+02:00\): .*e\.g\. 12:44 CEST/);
});

test("the setting: auto, UTC or a known zone; an unknown one is refused and reads as auto", () => {
    for (const ok of ["auto", "", "UTC", "Europe/Paris", "europe/paris"]) assert.equal(isTimeZoneSetting(ok), true, ok);
    assert.equal(isTimeZoneSetting("Mars/Base"), false);
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.equal(resolveTimeZone("auto"), local);
    assert.equal(resolveTimeZone(undefined), local);
    assert.equal(resolveTimeZone("Mars/Base"), local);
    assert.equal(resolveTimeZone("europe/paris"), "Europe/Paris");
    assert.equal(resolveTimeZone("UTC"), "UTC");
});
