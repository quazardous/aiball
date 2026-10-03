/**
 * #3509 — on_repetitive_denied: empty by default, armed past the threshold and
 * within the hourly budget, a static prompt or what an external command prints
 * from the context it gets on stdin; nothing when it fails, prints nothing or
 * hangs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ON_REPETITIVE_DENIED_DEFAULT, deniedContext, deniedPromptBlocker, parseOnRepetitiveDenied, resolveDeniedPrompt } from "./denied-prompt.js";
import { emptyDenialLog, withDenial, withDeniedPromptSent } from "./denials.js";

const T0 = Date.parse("2026-10-03T12:00:00Z");
const MIN = 60_000;
const denied = (n: number) => Array.from({ length: n }, (_, i) => i).reduce((l, i) => withDenial(l, T0 + i * MIN, "Auto-Mode Bypass", "Bash"), emptyDenialLog());

test("the config: empty by default; a malformed field keeps its default", () => {
    assert.deepEqual(parseOnRepetitiveDenied(undefined), ON_REPETITIVE_DENIED_DEFAULT);
    assert.deepEqual(ON_REPETITIVE_DENIED_DEFAULT, { threshold: 3, prompt: "", command: null, max_per_hour: 2 });
    assert.deepEqual(parseOnRepetitiveDenied({ threshold: 0, prompt: 7, command: "  ", max_per_hour: -1 }), ON_REPETITIVE_DENIED_DEFAULT);
    assert.deepEqual(parseOnRepetitiveDenied({ threshold: 5, prompt: "go on", command: "./unblock", max_per_hour: 0 }), { threshold: 5, prompt: "go on", command: "./unblock", max_per_hour: 0 });
});

test("armed only when configured, past the threshold, within the budget", () => {
    const cfg = { ...ON_REPETITIVE_DENIED_DEFAULT, prompt: "ok" };
    assert.match(deniedPromptBlocker(ON_REPETITIVE_DENIED_DEFAULT, denied(9), T0 + 10 * MIN)!, /no prompt configured/, "the default sends nothing");
    assert.match(deniedPromptBlocker(cfg, denied(2), T0 + 2 * MIN)!, /2\/3 denials/);
    assert.equal(deniedPromptBlocker(cfg, denied(3), T0 + 3 * MIN), null);
    const twice = withDeniedPromptSent(withDeniedPromptSent(denied(5), T0 + 3 * MIN), T0 + 4 * MIN);
    assert.match(deniedPromptBlocker(cfg, twice, T0 + 5 * MIN)!, /2\/2 prompts already sent/);
    assert.equal(deniedPromptBlocker(cfg, withDenial(withDenial(withDenial(twice, T0 + 70 * MIN, "r"), T0 + 71 * MIN, "r"), T0 + 72 * MIN, "r"), T0 + 72 * MIN), null, "an hour on, the budget is back");
    assert.match(deniedPromptBlocker({ ...cfg, max_per_hour: 0 }, denied(5), T0 + 5 * MIN)!, /0\/0/, "max_per_hour 0: never");
});

const ctx = deniedContext({ agent: "a-one", project: "p", cwd: tmpdir() }, denied(3).recent);

test("the context: the last denial, the hour's count and list", () => {
    assert.equal(ctx.tool, "Bash");
    assert.equal(ctx.reason, "Auto-Mode Bypass");
    assert.equal(ctx.last_hour, 3);
    assert.equal(ctx.recent[0]!.at, new Date(T0).toISOString());
});

test("a static prompt is sent as it is; an empty one is nothing", async () => {
    assert.deepEqual(await resolveDeniedPrompt({ ...ON_REPETITIVE_DENIED_DEFAULT, prompt: "  go on, the mkdir is fine  " }, ctx), { text: "go on, the mkdir is fine", source: "prompt" });
    assert.ok("none" in await resolveDeniedPrompt({ ...ON_REPETITIVE_DENIED_DEFAULT, prompt: "   " }, ctx));
});

test("a command gets the context on stdin; its stdout is the prompt; it wins over the static one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "denied-cmd-"));
    const seen = join(dir, "stdin.json");
    const r = await resolveDeniedPrompt({ ...ON_REPETITIVE_DENIED_DEFAULT, prompt: "static", command: `cat > ${seen}; echo "retry the $(basename $PWD)"` }, { ...ctx, cwd: dir });
    assert.deepEqual(r, { text: `retry the ${dir.split("/").pop()}`, source: "command" }, "run in the loop's folder");
    assert.deepEqual(JSON.parse(readFileSync(seen, "utf8")), { ...ctx, cwd: dir });
});

test("a command that fails, prints nothing or hangs sends nothing, and says why", async () => {
    const cmd = (command: string) => ({ ...ON_REPETITIVE_DENIED_DEFAULT, command });
    assert.deepEqual(await resolveDeniedPrompt(cmd("echo hi; exit 3"), ctx), { none: "command exited 3" });
    assert.deepEqual(await resolveDeniedPrompt(cmd("true"), ctx), { none: "command printed nothing" });
    assert.deepEqual(await resolveDeniedPrompt(cmd("sleep 5"), ctx, "/bin/sh", 200), { none: "command timed out after 200 ms" });
});
