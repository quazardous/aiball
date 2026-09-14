// #2458 david — a backlog head that comes back too soon after its previous wake,
// with nobody else moving in between, gets a `continue_after_minutes` hint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { backlogRewakeMinutes, buildContextPhrase } from "./state.js";
import type { AiballClient } from "../client.js";

const PINGS_YAML = new URL("../../config/defaults/claude-loop-pings.yaml", import.meta.url).pathname;
const STATE_TS = new URL("./state.ts", import.meta.url).pathname;
const NOW = Date.parse("2026-09-14T10:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const HINT = /It is back (\d+) min after your last wake on it, and nobody else has moved since: .*`continue_after_minutes` \(not 0\)/;

test("inside the window, nobody else moving: the minutes since the previous wake", () => {
    const base = { lastActor: "me", lastActorAt: ago(8), me: "me", nowMs: NOW, windowSec: 1800 };
    assert.equal(backlogRewakeMinutes({ ...base, lastWakeAt: ago(12) }), 12);
    assert.equal(backlogRewakeMinutes({ ...base, lastWakeAt: ago(0.2) }), 1, "never 0 min");
});

test("no hint: no previous wake, outside the window, window off, or someone else moved since", () => {
    const base = { lastActor: "me", lastActorAt: ago(8), me: "me", nowMs: NOW, windowSec: 1800 };
    assert.equal(backlogRewakeMinutes({ ...base, lastWakeAt: null }), null);
    assert.equal(backlogRewakeMinutes({ ...base, lastWakeAt: ago(30) }), null, "the window's end is exclusive");
    assert.equal(backlogRewakeMinutes({ ...base, lastWakeAt: ago(12), windowSec: 0 }), null);
    assert.equal(backlogRewakeMinutes({ ...base, lastWakeAt: ago(12), lastActor: "david", lastActorAt: ago(5) }), null,
        "a reply after the wake is a reason to come back");
    assert.equal(backlogRewakeMinutes({ ...base, lastWakeAt: ago(12), lastActor: "david", lastActorAt: ago(20) }), 12,
        "their word BEFORE the wake was already answered by it");
});

function stubClient(row: Record<string, unknown>): AiballClient {
    return {
        agentId: "claude-test",
        pingsCount: async () => ({ unread: 0 }),
        listProjectsDetailed: async () => [{ name: "aiball", open_count: 1, actionable_count: 1 }],
        unread: async () => ({ messages: [] }),
        getConsumer: async () => null,
        listTickets: async () => [{ id: 977, title: "backlog ticket", backlog_tier: 0, ...row }],
        getTicket: async () => ({ ticket: { title: "backlog ticket" }, comments: [] }),
        getProjectStandingPrompt: async () => null,
    } as unknown as AiballClient;
}

test("the shipped wake carries the hint on a ticket back too soon, and only then", async () => {
    const prev = process.env.AIBALL_AGENT;
    process.env.AIBALL_AGENT = "claude-test";
    try {
        const recent = new Date(Date.now() - 5 * 60_000).toISOString();
        const soon = await buildContextPhrase(stubClient({ backlog_last_wake_at: recent, last_actor: "claude-test", last_actor_at: recent }), null, PINGS_YAML);
        assert.match(soon.phrase, /look #977/);
        assert.match(soon.phrase, HINT);
        assert.equal(soon.phrase.match(HINT)?.[1], "5");

        const old = new Date(Date.now() - 45 * 60_000).toISOString();
        const late = await buildContextPhrase(stubClient({ backlog_last_wake_at: old }), null, PINGS_YAML);
        assert.match(late.phrase, /look #977/);
        assert.doesNotMatch(late.phrase, /It is back/);
    } finally {
        if (prev === undefined) delete process.env.AIBALL_AGENT; else process.env.AIBALL_AGENT = prev;
    }
});

test("the hint is in every shipped tone and in the state.ts fallback, word for word", () => {
    const clause = /\{head_rewake_minutes:\+ (?:[^{}]|\{head_rewake_minutes\})*\}/;
    const fallback = readFileSync(STATE_TS, "utf8").match(clause)?.[0];
    assert.ok(fallback, "state.ts has no rewake clause");
    const shipped = readFileSync(PINGS_YAML, "utf8");
    const tones = (shipped.match(/\{head_tier_triage:\+ /g) ?? []).length;
    assert.equal(shipped.split(fallback).length - 1, tones);
});
