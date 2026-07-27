import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HOOKS, HOOK_ENTRY, buildHookSettings } from "./registry.js";

// Stub command builder — deterministic, so we assert wiring without paths/tsx.
const cmd = (script: string) => `TSX ${script}`;
const BASE = cmd(HOOK_ENTRY);

test("buildHookSettings: event key order matches the registry order", () => {
    // Derived from HOOKS rather than spelled out: a literal list here is a
    // second inventory to maintain, and it fails on the day someone registers a
    // hook correctly — which teaches them the assertion is noise.
    const settings = buildHookSettings(HOOKS, cmd);
    assert.deepEqual(Object.keys(settings), HOOKS.map((h) => h.event));
});

test("every registered event reaches the settings exactly once", () => {
    const settings = buildHookSettings(HOOKS, cmd);
    assert.equal(Object.keys(settings).length, HOOKS.length, "no event silently collapsed");
    assert.equal(new Set(HOOKS.map((h) => h.event)).size, HOOKS.length, "no duplicate event key");
});

test("buildHookSettings: every command routes through the single dispatcher + the event arg", () => {
    const settings = buildHookSettings(HOOKS, cmd);
    assert.equal(settings.Stop[0].hooks[0].command, `${BASE} Stop`);
    assert.equal(settings.UserPromptSubmit[0].hooks[0].command, `${BASE} UserPromptSubmit`);
    // SessionStart: same command on every matcher entry.
    for (const e of settings.SessionStart) {
        assert.equal(e.hooks[0].command, `${BASE} SessionStart`);
        assert.equal(e.hooks[0].type, "command");
    }
    assert.equal(settings.PreToolUse[0].hooks[0].command, `${BASE} PreToolUse`);
});

test("buildHookSettings: matcher-less events emit a single entry with NO matcher key", () => {
    const settings = buildHookSettings(HOOKS, cmd);
    const matcherless = HOOKS.filter((h) => !h.matchers?.length).map((h) => h.event);
    assert.ok(matcherless.length > 0, "the case under test still exists in the registry");
    for (const event of matcherless) {
        assert.equal(settings[event].length, 1, `${event} has one entry`);
        assert.ok(!("matcher" in settings[event][0]), `${event} entry has no matcher key`);
        assert.deepEqual(Object.keys(settings[event][0]), ["hooks"]);
    }
});

test("the Notification spike is registered with NO matcher, on purpose", () => {
    // #1315 S0 asks which notification types actually reach a loop. Filtering on
    // the types the docs happen to list would make the observation confirm its
    // own premise, and a type nobody anticipated would never be seen.
    const spike = HOOKS.find((h) => h.event === "Notification");
    assert.ok(spike, "the spike is registered");
    assert.equal(spike!.matchers, undefined, "a matcher here would narrow the spike silently");
});

test("buildHookSettings: matcher entries serialize matcher before hooks", () => {
    const settings = buildHookSettings(HOOKS, cmd);
    assert.deepEqual(Object.keys(settings.PreToolUse[0]), ["matcher", "hooks"]);
    assert.equal(settings.PreToolUse[0].matcher, "AskUserQuestion");
});

test("SessionStart registers every entry mode INCLUDING compact (the previously-dropped matcher)", () => {
    const settings = buildHookSettings(HOOKS, cmd);
    assert.deepEqual(
        settings.SessionStart.map((e) => e.matcher),
        ["startup", "resume", "clear", "compact"],
    );
});

test("every registry spec declares a handler module", () => {
    for (const spec of HOOKS) {
        assert.ok(spec.module && spec.module.endsWith(".js"), `${spec.event} has a .js module`);
    }
});

// Integration smoke: the dispatcher runs the right handler and stays fail-open.
// UserPromptSubmit's handler emits `{}` and exits 0 (no loop state dir → it
// short-circuits, and even if it tried to emit, that's swallowed); an unknown
// event and a missing arg also emit `{}` and exit 0.
test("hook-entry dispatches by event and is fail-open", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const entry = join(here, "hook-entry.ts");
    const run = (args: string[]) =>
        execFileSync("npx", ["--no-install", "tsx", entry, ...args], {
            encoding: "utf8",
            input: "",
        }).trim();
    assert.equal(run(["UserPromptSubmit"]), "{}", "known event → handler emits {}");
    assert.equal(run(["NopeNotAnEvent"]), "{}", "unknown event → fail-open {}");
    assert.equal(run([]), "{}", "no event arg → fail-open {}");
});
