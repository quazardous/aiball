// #4201 — the attention report reads the transcripts of every Claude config dir the known folders use.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptRoots } from "./attention-sources.js";

const root = mkdtempSync(join(tmpdir(), "att-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("a folder's claude.config_dir is read besides ~/.claude's, each dir once", () => {
    const home = join(root, "dot-claude", "projects");
    const own = join(root, "dot-claude-admi");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(own, "projects"), { recursive: true });
    const admi = join(root, "admi");
    const other = join(root, "other");
    mkdirSync(admi);
    mkdirSync(other);
    writeFileSync(join(admi, ".aiball.yaml"), `consumer:\n  project: admi\nclaude:\n  config_dir: ${own}\n`);
    writeFileSync(join(other, ".aiball.yaml"), "consumer:\n  project: other\n");
    // ~/.claude's projects/ reached a second time through a link: read once.
    symlinkSync(home, join(root, "linked-projects"));
    const roots = transcriptRoots([home, join(root, "linked-projects")], [admi, other, admi, null, join(root, "gone")], undefined);
    assert.ok(roots.includes(join(own, "projects")), roots.join(", "));
    assert.equal(roots.filter((r) => r === home || r === join(root, "linked-projects")).length, 1, "one dir, two paths: once");
    assert.equal(new Set(roots).size, roots.length);
});

test("a config dir without projects/ yet, or a folder that is gone, adds nothing", () => {
    const f = join(root, "fresh");
    mkdirSync(f);
    writeFileSync(join(f, ".aiball.yaml"), `consumer:\n  project: fresh\nclaude:\n  config_dir: ${join(root, "never-run")}\n`);
    assert.deepEqual(transcriptRoots([], [f, join(root, "nowhere")]), []);
});
