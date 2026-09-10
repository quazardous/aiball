// #2180 — `init --deny-code` must end up as the `claude.deny_tools` claude-loop
// spawns with (#2201). Real files and the real `loadConfig`: the chain under
// test is flag → yaml → config, and a stub at either end would pass while the
// other stayed disconnected.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { CODE_TOOLS, denyCodeYamlBlock, patchDenyTools } from "./bootstrap.js";
import { loadConfig } from "../autopoll/config.js";

function withoutAmbientIdentity<T>(fn: () => T): T {
    const saved = { project: process.env.AIBALL_PROJECT, agent: process.env.AIBALL_AGENT, cwd: process.env.AIBALL_CWD };
    delete process.env.AIBALL_PROJECT;
    delete process.env.AIBALL_AGENT;
    delete process.env.AIBALL_CWD;
    try {
        return fn();
    } finally {
        if (saved.project !== undefined) process.env.AIBALL_PROJECT = saved.project;
        if (saved.agent !== undefined) process.env.AIBALL_AGENT = saved.agent;
        if (saved.cwd !== undefined) process.env.AIBALL_CWD = saved.cwd;
    }
}

const quietly = <T>(fn: () => T): T => {
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try { return fn(); } finally { process.stdout.write = write; }
};

test("a fresh .aiball.yaml with --deny-code denies the file and shell tools to the spawned session", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiball-denycode-"));
    try {
        writeFileSync(join(dir, ".aiball.yaml"), `consumer:\n  agent: cto\n  project: p\n${denyCodeYamlBlock()}autopoll:\n  enabled: true\n`);
        const cfg = withoutAmbientIdentity(() => loadConfig(dir));
        assert.deepEqual(cfg.claude.deny_tools, [...CODE_TOOLS]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("--deny-code on an existing .aiball.yaml adds the list and keeps every other key and comment", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiball-denycode-"));
    const path = join(dir, ".aiball.yaml");
    try {
        writeFileSync(path, "# hand-written, keep me\nconsumer:\n  agent: cto\n  project: p\nclaude:\n  always_resume: false\n");
        quietly(() => patchDenyTools(path));
        const text = readFileSync(path, "utf8");
        assert.match(text, /# hand-written, keep me/);
        const y = parse(text) as { consumer: { agent: string }; claude: { always_resume: boolean; deny_tools: string[] } };
        assert.equal(y.consumer.agent, "cto");
        assert.equal(y.claude.always_resume, false);
        assert.deepEqual(y.claude.deny_tools, [...CODE_TOOLS]);
        const cfg = withoutAmbientIdentity(() => loadConfig(dir));
        assert.deepEqual(cfg.claude.deny_tools, [...CODE_TOOLS]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("--deny-code on an existing .aiball.yaml WITHOUT a claude block creates it (the common case)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiball-denycode-"));
    const path = join(dir, ".aiball.yaml");
    try {
        writeFileSync(path, "# no claude block here\nconsumer:\n  agent: cto\n  project: p\nautopoll:\n  enabled: true\n");
        quietly(() => patchDenyTools(path));
        const y = parse(readFileSync(path, "utf8")) as { consumer: { agent: string }; autopoll: { enabled: boolean }; claude: { deny_tools: string[] } };
        assert.deepEqual(y.claude.deny_tools, [...CODE_TOOLS]);
        assert.equal(y.consumer.agent, "cto");
        assert.equal(y.autopoll.enabled, true);
        assert.match(readFileSync(path, "utf8"), /# no claude block here/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
