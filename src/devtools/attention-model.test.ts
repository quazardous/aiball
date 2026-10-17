// #4088 — the snap model and the prompt classifier, on synthetic traces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimate, hoursByDay, periods, sharedPeriods, supervisedOnly, type Act, type AttentionParams } from "./attention-model.js";
import { classifyPrompt, projectFromDirName, spentTokens, transcriptDirName } from "./attention-sources.js";

const P: AttentionParams = { snapSec: 600, leadSec: 60, tailSec: 120 };
const T0 = Date.parse("2026-10-14T10:00:00Z");
const MIN = 60_000;
const act = (min: number, project: string): Act => ({ at: T0 + min * MIN, project, kind: "comment" });

test("acts within the snap glue into one continuous period, with a lead and a tail", () => {
    const [p, ...rest] = periods([act(0, "a"), act(4, "a"), act(13, "b")], P);
    assert.equal(rest.length, 0, "gaps of 4 and 9 min, under the 10 min snap: one period");
    assert.equal(p.start, T0 - 1 * MIN);
    assert.equal(p.end, T0 + 13 * MIN + 2 * MIN);
});

test("a gap over the snap opens a new period; a lead never counts the previous tail twice", () => {
    const ps = periods([act(0, "a"), act(11, "a")], { snapSec: 600, leadSec: 600, tailSec: 300 });
    assert.equal(ps.length, 2);
    assert.equal(ps[1].start, ps[0].end, "the lead of the second stops where the first's tail ends");
});

test("a period is shared in proportion to the acts on each project", () => {
    const [p] = sharedPeriods([act(0, "a"), act(1, "a"), act(2, "a"), act(3, "b")], P);
    assert.equal(p.shares.get("a"), 0.75);
    assert.equal(p.shares.get("b"), 0.25);
});

test("--weight tokens shares a period by what each project's sessions spent in it", () => {
    const acts = [act(0, "a"), act(1, "b")];
    const spend = [
        { at: T0 + 30_000, project: "a", tokens: 100 },
        { at: T0 + 90_000, project: "b", tokens: 300 },
        { at: T0 + 60 * MIN, project: "a", tokens: 1_000_000 }, // outside the period: ignored
    ];
    const [p] = sharedPeriods(acts, P, "tokens", spend);
    assert.equal(p.shares.get("a"), 0.25);
    assert.equal(p.shares.get("b"), 0.75);
    const [q] = sharedPeriods(acts, P, "tokens", []);
    assert.equal(q.shares.get("a"), 0.5, "no tokens in the period: back to acts");
});

test("hours per day: a period split at local midnight, each part shared", () => {
    const shares = new Map([["a", 0.5], ["b", 0.5]]);
    const map = hoursByDay([{ start: Date.parse("2026-10-14T23:00:00Z"), end: Date.parse("2026-10-15T01:00:00Z"), shares }], "UTC");
    assert.equal(map.get("2026-10-14")?.get("a"), 0.5);
    assert.equal(map.get("2026-10-15")?.get("b"), 0.5);
});

test("estimate: a period's hours add up to its length", () => {
    const out = estimate([act(0, "a"), act(5, "b")], P, { timeZone: "UTC" });
    const day = out.get("2026-10-14")!;
    const total = [...day.values()].reduce((x, y) => x + y, 0);
    assert.ok(Math.abs(total - (1 + 5 + 2) / 60) < 1e-9);
});

test("a loop's wake is told from a human's prompt by its text", () => {
    const human = { origin: { kind: "human" } };
    assert.equal(classifyPrompt(human, "regarde 3969 et ajoute une config"), "human");
    assert.equal(classifyPrompt(human, "Wake up, Neo. look #4025: Check that a workspace can be edited. Not triaged until a `then:`"), "wake");
    assert.equal(classifyPrompt(human, "it should adapt to other CPUs (#4012 / #jx69wx) · another agent wrote this"), "wake");
    assert.equal(classifyPrompt(human, "The plan was ACCEPTED — execute, the ticket is yours on #4014"), "wake");
    assert.equal(classifyPrompt({ origin: { kind: "task-notification" } }, "<task-notification>…"), null);
    assert.equal(classifyPrompt({ isMeta: true }, "Base directory for this skill"), null);
    assert.equal(classifyPrompt(human, "<bash-stdout>ok</bash-stdout>"), null);
});

test("tokens spent: new input and output, not re-read cache", () => {
    assert.equal(spentTokens({ input_tokens: 2, cache_creation_input_tokens: 100, output_tokens: 30 }), 132);
    assert.equal(spentTokens(undefined), 0);
});

test("transcript directories map to projects", () => {
    assert.equal(transcriptDirName("/home/d/Private/dev/projects/quazardous/aiball"), "-home-d-Private-dev-projects-quazardous-aiball");
    assert.equal(projectFromDirName("-home-david-Private-dev-projects-quazardous-helios"), "helios");
    assert.equal(projectFromDirName("-home-david-Private-dev-projects-M2M-m2m-infra"), "M2M-m2m-infra");
    assert.equal(projectFromDirName("-home-david-work-math"), "work");
    assert.equal(projectFromDirName("-home-david--config-Claude-scratch-workspaces-b3a2-scratch-2026-10-16-c0e5"), "config");
});

test("a ticket an agent filed counts only next to a human act", () => {
    const human = [act(0, "a"), act(120, "a")];
    const filed = [act(20, "a"), act(-25, "b"), act(60, "c"), act(200, "d")];
    assert.deepEqual(supervisedOnly(filed, human).map((x) => x.project), ["a", "b"], "20 min after, 25 min before: kept; 60 min from both, 80 min after the last: left out");
    assert.deepEqual(supervisedOnly(filed, []), [], "no human act: nothing");
});
