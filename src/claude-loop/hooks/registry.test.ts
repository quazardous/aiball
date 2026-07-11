import { test } from "node:test";
import assert from "node:assert/strict";
import { HOOKS, buildHookSettings } from "./registry.js";

// Stub command builder — deterministic, so we assert wiring without paths/tsx.
const cmd = (script: string) => `TSX ${script}`;

test("buildHookSettings: event key order matches the registry order", () => {
    const settings = buildHookSettings(HOOKS, cmd);
    assert.deepEqual(Object.keys(settings), [
        "SessionStart",
        "Stop",
        "UserPromptSubmit",
        "PreToolUse",
    ]);
});

test("buildHookSettings: matcher-less events emit a single entry with NO matcher key", () => {
    const settings = buildHookSettings(HOOKS, cmd);
    for (const event of ["Stop", "UserPromptSubmit"]) {
        assert.equal(settings[event].length, 1, `${event} has one entry`);
        const entry = settings[event][0];
        assert.ok(!("matcher" in entry), `${event} entry has no matcher key`);
        assert.deepEqual(Object.keys(entry), ["hooks"]);
    }
});

test("buildHookSettings: matcher entries serialize matcher before hooks (parity)", () => {
    const settings = buildHookSettings(HOOKS, cmd);
    const entry = settings.PreToolUse[0];
    assert.deepEqual(Object.keys(entry), ["matcher", "hooks"]);
    assert.equal(entry.matcher, "AskUserQuestion");
});

test("buildHookSettings: commands are wired from the registry scripts", () => {
    const settings = buildHookSettings(HOOKS, cmd);
    assert.equal(settings.Stop[0].hooks[0].command, "TSX src/claude-loop/stop-hook.ts");
    assert.equal(settings.Stop[0].hooks[0].type, "command");
    assert.equal(
        settings.SessionStart[0].hooks[0].command,
        "TSX src/claude-loop/session-start-hook.ts",
    );
});

test("SessionStart registers every entry mode INCLUDING compact (the previously-dropped matcher)", () => {
    const settings = buildHookSettings(HOOKS, cmd);
    const matchers = settings.SessionStart.map((e) => e.matcher);
    assert.deepEqual(matchers, ["startup", "resume", "clear", "compact"]);
});

test("parity with the legacy hand-built object modulo the added compact matcher", () => {
    const settings = buildHookSettings(HOOKS, cmd);
    // The legacy object registered SessionStart against startup/resume/clear
    // only; everything else is identical. Drop the new compact entry and the
    // generated object must equal the legacy shape byte-for-byte.
    const ss = cmd("src/claude-loop/session-start-hook.ts");
    const legacy = {
        SessionStart: [
            { matcher: "startup", hooks: [{ type: "command", command: ss }] },
            { matcher: "resume", hooks: [{ type: "command", command: ss }] },
            { matcher: "clear", hooks: [{ type: "command", command: ss }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: cmd("src/claude-loop/stop-hook.ts") }] }],
        UserPromptSubmit: [
            { hooks: [{ type: "command", command: cmd("src/claude-loop/user-prompt-submit-hook.ts") }] },
        ],
        PreToolUse: [
            {
                matcher: "AskUserQuestion",
                hooks: [{ type: "command", command: cmd("src/claude-loop/pretooluse-hook.ts") }],
            },
        ],
    };
    const generated = structuredClone(settings);
    generated.SessionStart = generated.SessionStart.filter((e) => e.matcher !== "compact");
    assert.equal(JSON.stringify(generated), JSON.stringify(legacy));
});
