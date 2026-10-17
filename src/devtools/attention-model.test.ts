// #4088 — the attention model and the prompt classifier, on synthetic traces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimate, hoursByDay, stretches, timeline, type Act, type AttentionParams } from "./attention-model.js";
import { classifyPrompt, projectFromDirName, transcriptDirName } from "./attention-sources.js";

const P: AttentionParams = { readCps: 10, typeCps: 2, switchSec: 60, gapSec: 900, watchSec: 120, maxReadSec: 300 };
const T0 = Date.parse("2026-10-14T10:00:00Z");
const act = (min: number, project: string, readChars = 0, typeChars = 0): Act => ({ at: T0 + min * 60_000, project, kind: "comment", readChars, typeChars });

test("one act: a switch, its reading and typing before it, a watch after it", () => {
    const [s] = stretches([act(0, "a", 600, 120)], P);
    // 60 s switch + 600/10 = 60 s read + 120/2 = 60 s type = 3 min before; 2 min after.
    assert.equal(s.start, T0 - 180_000);
    assert.equal(s.end, T0 + 120_000);
});

test("reading is capped: hours of agent output are not read", () => {
    const [s] = stretches([act(0, "a", 1_000_000, 0)], P);
    assert.equal(T0 - s.start, (60 + 300) * 1000);
});

test("no switch on the same project within the gap; a switch on another project or after the gap", () => {
    const s = stretches([act(0, "a"), act(5, "a"), act(10, "b"), act(40, "b")], P);
    assert.equal(s[1].start, T0 + 5 * 60_000, "same project, 5 min later: no switch");
    assert.equal(s[2].start, T0 + 10 * 60_000 - 60_000, "another project: a switch");
    assert.equal(s[3].start, T0 + 40 * 60_000 - 60_000, "30 min later: a return, a switch");
});

test("overlaps are counted once: the later act takes over from its start", () => {
    const line = timeline(stretches([act(0, "a"), act(1, "b")], P));
    const total = line.reduce((n, s) => n + s.end - s.start, 0);
    // a: [-1, +2] min cut at b's start (0: b starts 1 min before its act); b: [0, +3].
    assert.equal(total, 4 * 60_000);
    assert.deepEqual(line.map((s) => s.project), ["a", "b"]);
});

test("hours per day, split at local midnight", () => {
    const tz = "UTC";
    const map = hoursByDay([{ start: Date.parse("2026-10-14T23:30:00Z"), end: Date.parse("2026-10-15T00:30:00Z"), project: "a" }], tz);
    assert.equal(map.get("2026-10-14")?.get("a"), 0.5);
    assert.equal(map.get("2026-10-15")?.get("a"), 0.5);
});

test("estimate: projects and days add up", () => {
    const out = estimate([act(0, "a"), act(60, "b")], P, "UTC");
    const day = out.get("2026-10-14")!;
    assert.ok(day.get("a")! > 0 && day.get("b")! > 0);
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

test("transcript directories map to projects", () => {
    assert.equal(transcriptDirName("/home/d/Private/dev/projects/quazardous/aiball"), "-home-d-Private-dev-projects-quazardous-aiball");
    assert.equal(projectFromDirName("-home-david-Private-dev-projects-quazardous-helios"), "helios");
    assert.equal(projectFromDirName("-home-david-Private-dev-projects-M2M-m2m-infra"), "M2M-m2m-infra");
});
