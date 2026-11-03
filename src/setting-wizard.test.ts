/**
 * #4682 — a setting's wizard: the engine and the `claude.config_dir` plan,
 * driven on a machine and a clock of the test's own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { answersRefusal, cancellable, newRun, runWizard, type WizardRun } from "./setting-wizard.js";
import { configDirPlan, FREE_WAIT_MS, IDLE_WAIT_MS, type ConfigDirOps, type FolderLoop } from "./setting-wizard-config-dir.js";

const CWD = "/p/mosquito";

/** A machine: loops that run, busy or not, Claude processes, and what was done to it, in order. */
function machine(o: { loops?: string[]; busyFor?: number; claudeFor?: number; firstRunDone?: boolean; startFails?: string[] } = {}) {
    const clock = { now: 1_000_000 };
    const running = new Set(o.loops ?? []);
    const did: string[] = [];
    const t0 = clock.now;
    const ops: ConfigDirOps = {
        loops: () => [...running].map((name) => ({ name, agent: `${name}-claude` })),
        busy: () => clock.now - t0 < (o.busyFor ?? 0),
        running: (l: FolderLoop) => running.has(l.name),
        stop: async (l) => { did.push(`stop ${l.name}`); running.delete(l.name); },
        start: async (l) => {
            did.push(`start ${l.name}`);
            if (o.startFails?.includes(l.name)) throw new Error("did not come back");
            running.add(l.name);
        },
        claudeRunning: () => (clock.now - t0 < (o.claudeFor ?? 0) ? [{ pid: 42, cmd: "claude" }] : []),
        currentDir: () => "/home/u/.claude",
        target: (_cwd, value) => ({ dir: value === null ? "/home/u/.claude-default" : value.replace("~", "/home/u"), firstRunDone: o.firstRunDone ?? true }),
        write: (_cwd, value, opts) => { did.push(`write ${value} move=${opts.moveSessions} fork=${opts.fork}`); return { moved: 3 }; },
        settings: () => ({ config_dir: "after" }),
    };
    return { ops, did, clock };
}

async function run(m: ReturnType<typeof machine>, answers: Record<string, unknown>, cancelAt?: number): Promise<WizardRun> {
    const plan = configDirPlan(CWD, "~/.claude-b", m.ops);
    const r = newRun("w-1", CWD, plan.preview, new Date(m.clock.now).toISOString());
    const seen: string[] = [];
    await runWizard(r, plan, {
        answers,
        changed: () => seen.push(r.status),
        cancelRequested: () => cancelAt !== undefined && m.clock.now >= cancelAt,
        sleep: async (ms) => { m.clock.now += ms; },
        now: () => m.clock.now,
    });
    return r;
}

const OK = { confirm: true, move_sessions: "yes" };
const steps = (r: WizardRun) => r.steps.map((s) => `${s.id}:${s.status}`).join(" ");

test("the preview names the loops, asks the fork only for a dir never run, and leaves out the loop steps without loops", () => {
    const m = machine({ loops: ["cl-a"], firstRunDone: false });
    const p = configDirPlan(CWD, "~/.claude-b", m.ops).preview;
    assert.deepEqual(p.loops, [{ name: "cl-a", agent: "cl-a-claude", busy: false }]);
    assert.deepEqual(p.questions.map((q) => q.id), ["confirm", "fork", "move_sessions"]);
    assert.match(p.questions[0].label, /1 loop \(cl-a-claude\)/);
    assert.deepEqual(p.questions.map((q) => q.facts), [
        { current: "/home/u/.claude", target: "/home/u/.claude-b", loops: ["cl-a"] },
        { current: "/home/u/.claude", target: "/home/u/.claude-b", target_first_run: false },
        { from: "/home/u/.claude", to: "/home/u/.claude-b" },
    ], "the facts each label names, for a client in another language");
    assert.deepEqual([p.fallback_code, p.fallback_facts], ["restart_on_current", { current: "/home/u/.claude", loops: ["cl-a"] }]);
    assert.deepEqual(p.steps.map((s) => s.id), ["idle", "stop", "free", "write", "start"]);
    assert.deepEqual(p.steps.filter((s) => s.point_of_no_return).map((s) => s.id), ["write"]);

    const bare = configDirPlan(CWD, "~/.claude-b", machine({ firstRunDone: true }).ops).preview;
    assert.deepEqual(bare.questions.map((q) => q.id), ["confirm", "move_sessions"], "a dir already run: nothing to fork");
    assert.deepEqual(bare.steps.map((s) => s.id), ["free", "write"]);
    assert.equal(m.did.length, 0, "a preview runs nothing");
});

test("#4690 null goes back to the dir the folder falls back to, with the same steps and no fork", () => {
    const m = machine({ loops: ["cl-a"], firstRunDone: false });
    const p = configDirPlan(CWD, null, m.ops).preview;
    assert.equal(p.value, null);
    assert.deepEqual(p.questions.map((q) => q.id), ["confirm", "move_sessions"], "no fork: the folder falls back to a dir, it does not start one");
    assert.deepEqual(p.questions[0].facts, { current: "/home/u/.claude", target: "/home/u/.claude-default", loops: ["cl-a"] });
    assert.deepEqual(p.steps.map((s) => s.id), ["idle", "stop", "free", "write", "start"]);
});

test("refused: the same dir, a value that is not a path", () => {
    const m = machine();
    assert.throws(() => configDirPlan(CWD, "/home/u/.claude", m.ops), /already start Claude with/);
    assert.throws(() => configDirPlan(CWD, 42, m.ops), /directory path/);
    assert.throws(() => configDirPlan(CWD, "  ", m.ops), /directory path/);
});

test("the answers must answer every question, with an option it offers", () => {
    const p = configDirPlan(CWD, "~/.claude-b", machine({ firstRunDone: false }).ops).preview;
    assert.match(answersRefusal(p, {}) ?? "", /confirm/);
    assert.match(answersRefusal(p, { confirm: true, fork: "maybe", move_sessions: "yes" }) ?? "", /fork: one of fork, empty/);
    assert.equal(answersRefusal(p, { confirm: true, fork: "fork", move_sessions: "no" }), null);
});

test("a switch goes through: waits for the busy loop, stops, waits for Claude to end, writes, starts again", async () => {
    const m = machine({ loops: ["cl-a", "cl-b"], busyFor: 4_000, claudeFor: 7_000, firstRunDone: false });
    const r = await run(m, { ...OK, fork: "fork" });
    assert.equal(r.status, "done", steps(r));
    assert.deepEqual(m.did, ["stop cl-a", "stop cl-b", "write ~/.claude-b move=true fork=true", "start cl-a", "start cl-b"]);
    assert.equal(steps(r), "idle:done stop:done free:done write:done start:done");
    assert.deepEqual(r.steps.find((s) => s.id === "write")!.details, { dir: "/home/u/.claude-b", moved: 3 });
    assert.deepEqual(r.steps.map((s) => s.code), ["loops_idle", "stopped", "folder_free", "written", "started"], "a code beside each sentence");
    assert.deepEqual([r.fallback, r.settings], [null, { config_dir: "after" }]);
    assert.ok(r.ended_at);
});

test("a loop still busy at the bound: nothing changed, nothing to fall back on", async () => {
    const m = machine({ loops: ["cl-a"], busyFor: IDLE_WAIT_MS + 60_000 });
    const r = await run(m, OK);
    assert.equal(r.status, "failed");
    assert.equal(steps(r), "idle:failed stop:skipped free:skipped write:skipped start:skipped");
    assert.match(r.steps[0].said!, /Still busy after 5 min: cl-a-claude; nothing changed/);
    assert.deepEqual([r.steps[0].code, r.steps[0].details], ["still_busy", { busy: ["cl-a"], waited_s: 300 }]);
    assert.deepEqual([m.did, r.fallback], [[], null]);
});

test("a Claude that does not end before the write: the stopped loops start again on the current dir", async () => {
    const m = machine({ loops: ["cl-a"], claudeFor: FREE_WAIT_MS + 60_000 });
    const r = await run(m, OK);
    assert.equal(r.status, "failed");
    assert.match(r.steps.find((s) => s.id === "free")!.said!, /still runs in the folder after 30 s \(42\)/);
    assert.deepEqual(m.did, ["stop cl-a", "start cl-a"], "no write; the fallback started it again");
    assert.deepEqual(r.fallback, { ran: true, said: "Started cl-a-claude again on /home/u/.claude", code: "restarted_on_current", details: { dir: "/home/u/.claude", restarted: ["cl-a"], failed: [] } });
    assert.equal(r.steps.find((s) => s.id === "free")!.code, "claude_still_in_folder");
});

test("a cancel while waiting stops the run there; the fallback restores what it had stopped", async () => {
    const m = machine({ loops: ["cl-a"], busyFor: 60_000 });
    const r = await run(m, OK, 1_000_000 + 10_000);
    assert.equal(r.status, "cancelled");
    assert.equal(steps(r), "idle:skipped stop:skipped free:skipped write:skipped start:skipped");
    assert.deepEqual(m.did, []);
});

test("past the point of no return there is no cancel, and a loop that does not come back is named", async () => {
    const m = machine({ loops: ["cl-a", "cl-b"], startFails: ["cl-b"] });
    const plan = configDirPlan(CWD, "~/.claude-b", m.ops);
    const r = newRun("w-2", CWD, plan.preview, "t");
    assert.equal(cancellable(r), true);
    r.steps.find((s) => s.id === "write")!.status = "running";
    assert.equal(cancellable(r), false);

    const done = await run(m, OK, 0);
    assert.equal(done.status, "cancelled", "a cancel asked from the start stops before anything");
    const m2 = machine({ loops: ["cl-a", "cl-b"], startFails: ["cl-b"] });
    const failed = await run(m2, OK);
    assert.equal(failed.status, "failed");
    assert.match(failed.steps.find((s) => s.id === "start")!.said!, /Not started again: cl-b; the dir is written/);
    assert.equal(failed.steps.find((s) => s.id === "start")!.code, "not_started");
    assert.equal(failed.fallback, null, "past the write, the fallback does not run");
});
