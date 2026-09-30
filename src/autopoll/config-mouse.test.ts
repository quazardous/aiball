// #3017 — `claude_loop.mouse`: on by default, set globally, overridden per project.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "aiball-3017-"));
process.env.XDG_CONFIG_HOME = join(root, "xdg");
mkdirSync(join(root, "xdg", "aiball"), { recursive: true });
const { loadConfig, defaultLoopSession } = await import("./config.js");
after(() => rmSync(root, { recursive: true, force: true }));

function project(name: string, yaml: string | null): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    if (yaml !== null) writeFileSync(join(dir, ".aiball.yaml"), yaml);
    return dir;
}
const global = (yaml: string) => writeFileSync(join(root, "xdg", "aiball", "config.yaml"), yaml);

test("on by default, when nothing sets it", () => {
    global("");
    assert.equal(loadConfig(project("p-default", null)).claude_loop.mouse, true);
});

test("the global setting applies, and a project can override it", () => {
    global("claude_loop:\n  mouse: off\n");
    assert.equal(loadConfig(project("p-global", "consumer:\n  project: p-global\n")).claude_loop.mouse, false);
    assert.equal(loadConfig(project("p-override", "claude_loop:\n  mouse: on\n")).claude_loop.mouse, true);
});

test("a value that is neither on nor off is ignored", () => {
    global("claude_loop:\n  mouse: sometimes\n");
    assert.equal(loadConfig(project("p-junk", null)).claude_loop.mouse, true);
});

test("#3044 — claude_loop.bar: tmux by default, set globally, overridden per project, junk ignored", () => {
    global("");
    assert.equal(loadConfig(project("b-default", null)).claude_loop.bar, "tmux");
    global("claude_loop:\n  bar: external\n");
    assert.equal(loadConfig(project("b-global", "consumer:\n  project: b-global\n")).claude_loop.bar, "external");
    assert.equal(loadConfig(project("b-override", "claude_loop:\n  bar: tmux\n")).claude_loop.bar, "tmux");
    global("claude_loop:\n  bar: web\n");
    assert.equal(loadConfig(project("b-junk", null)).claude_loop.bar, "tmux");
});

test("#3393 — claude_loop.questions: present by default, set globally, overridden per project, junk ignored", () => {
    global("");
    assert.equal(loadConfig(project("q-default", null)).claude_loop.questions, "present");
    global("claude_loop:\n  questions: ticket_only\n");
    assert.equal(loadConfig(project("q-global", "consumer:\n  project: q-global\n")).claude_loop.questions, "ticket_only");
    assert.equal(loadConfig(project("q-override", "claude_loop:\n  questions: present\n")).claude_loop.questions, "present");
    global("claude_loop:\n  questions: never\n");
    assert.equal(loadConfig(project("q-junk", null)).claude_loop.questions, "present");
    assert.equal(loadConfig(project("q-project", "claude_loop:\n  questions: ticket_only\n")).claude_loop.questions, "ticket_only");
});

test("#3135 — claude_loop.session: the platform default, set globally, overridden per project, junk ignored", () => {
    global("");
    assert.equal(loadConfig(project("s-default", null)).claude_loop.session, defaultLoopSession());
    global("claude_loop:\n  session: tmux\n");
    assert.equal(loadConfig(project("s-global", "consumer:\n  project: s-global\n")).claude_loop.session, "tmux");
    assert.equal(loadConfig(project("s-override", "claude_loop:\n  session: host\n")).claude_loop.session, "host");
    global("claude_loop:\n  session: screen\n");
    assert.equal(loadConfig(project("s-junk", "claude_loop:\n  session: nope\n")).claude_loop.session, defaultLoopSession());
});

test("the session defaults to tmux on Windows, where the session host does not run yet — host elsewhere", () => {
    // Temporary: the session host is built on Unix sockets. An explicit
    // `session: host` is still honoured (s-override above), on every platform.
    assert.equal(defaultLoopSession("win32"), "tmux");
    assert.equal(defaultLoopSession("linux"), "host");
    assert.equal(defaultLoopSession("darwin"), "host");
});
