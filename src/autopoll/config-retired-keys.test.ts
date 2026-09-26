// #3043 — a key that no longer means anything (`claude_loop.proxy_impl`) is
// ignored, never refused, and reported so claude-loop can say to remove it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "aiball-3043-"));
process.env.XDG_CONFIG_HOME = join(root, "xdg");
mkdirSync(join(root, "xdg", "aiball"), { recursive: true });
const { loadConfig } = await import("./config.js");
after(() => rmSync(root, { recursive: true, force: true }));

function project(name: string, yaml: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".aiball.yaml"), yaml);
    return dir;
}

test("proxy_impl is reported as retired, and the rest of the block still applies", () => {
    const cfg = loadConfig(project("p-old", "claude_loop:\n  proxy_impl: python\n  afk_window_ms: 1234\n"));
    assert.deepEqual(cfg.retired_keys, ["claude_loop.proxy_impl"]);
    assert.equal(cfg.claude_loop.afk_window_ms, 1234);
});

test("a config without it reports nothing", () => {
    assert.deepEqual(loadConfig(project("p-clean", "claude_loop:\n  afk_window_ms: 1234\n")).retired_keys, []);
});
