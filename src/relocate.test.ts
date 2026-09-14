// #2468 — `aiball relocate`, on a fake home only: never the real ~/.claude.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    applyRelocate,
    claudeProjectKey,
    planRelocate,
    rewriteClaudeJsonProjects,
    rewriteFieldPaths,
    type RelocateEnv,
} from "./relocate.js";

const ROOTS: string[] = [];
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

/** A machine: two projects side by side, one of them a name-prefix of the other. */
function machine(opts: { processes?: Array<{ pid: number; cwd: string; cmd: string }>; alive?: number[] } = {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "aiball-2468-")));
    ROOTS.push(root);
    const projects = join(root, "projects");
    const oldDir = join(projects, "BookShepherd", "jobbox");
    const sibling = join(projects, "BookShepherd", "jobbox2");
    const newDir = join(projects, "quazardous", "jobbox");
    mkdirSync(join(oldDir, "wrap"), { recursive: true });
    mkdirSync(sibling, { recursive: true });
    mkdirSync(join(projects, "quazardous"), { recursive: true });
    writeFileSync(join(oldDir, "Cargo.toml"), "[package]\n");

    const claudeDir = join(root, ".claude");
    const t = (cwd: string, extra = "") => `{"type":"user","cwd":"${cwd}","message":"cd ${oldDir} && ls${extra}"}\n`;
    const mk = (dir: string, lines: string) => { mkdirSync(join(claudeDir, "projects", claudeProjectKey(dir)), { recursive: true }); writeFileSync(join(claudeDir, "projects", claudeProjectKey(dir), "s1.jsonl"), lines); };
    mk(oldDir, t(oldDir) + t(join(oldDir, "wrap")) + t(oldDir));
    mk(join(oldDir, "wrap"), t(join(oldDir, "wrap")));
    mk(sibling, t(sibling));
    // The key is lossy: this sibling's key starts like a SUBFOLDER of jobbox would.
    const lookalike = join(projects, "BookShepherd", "jobbox-tools");
    mk(lookalike, t(lookalike));
    writeFileSync(join(claudeDir, "history.jsonl"),
        `{"display":"a","project":"${oldDir}"}\n{"display":"b","project":"${sibling}"}\n{"display":"c","project":"${join(oldDir, "wrap")}"}\n`);
    const claudeJson = join(root, ".claude.json");
    writeFileSync(claudeJson, JSON.stringify({ numStartups: 3, projects: { [oldDir]: { hasTrustDialogAccepted: true }, [sibling]: { hasTrustDialogAccepted: false } } }, null, 2));

    const loopRoot = join(root, ".claude-loop");
    mkdirSync(join(loopRoot, "cl-jobbox-1"), { recursive: true });
    writeFileSync(join(loopRoot, "cl-jobbox-1", "plate.json"), JSON.stringify({ name: "cl-jobbox-1", cwd: oldDir, pings_src: join(oldDir, "pings.yaml") }, null, 2));
    writeFileSync(join(loopRoot, "cl-jobbox-1", "loop.pid"), "4242");

    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(join(oldDir, "Cargo.toml"), join(bin, "jb-link"));
    const ws = join(root, "workspaces");
    mkdirSync(ws);
    writeFileSync(join(ws, "jobbox.code-workspace"), `{"folders":[{"path":"../projects/BookShepherd/jobbox"}]}`);

    const env: RelocateEnv = {
        claudeDir, claudeJson, loopRoot,
        scanRoots: [bin, ws],
        processCwds: () => opts.processes ?? [],
        pidAlive: (pid) => (opts.alive ?? []).includes(pid),
    };
    return { root, oldDir, newDir, sibling, lookalike, claudeDir, claudeJson, loopRoot, bin, ws, env };
}

test("the Claude key maps every non-alphanumeric character to '-', as the real ~/.claude does", () => {
    assert.equal(claudeProjectKey("/home/david/Private/dev/projects/work/kodi_sauvagge"), "-home-david-Private-dev-projects-work-kodi-sauvagge");
});

test("field rewrites touch only the named fields, only the old path and what lies under it", () => {
    const text = `{"cwd":"/a/jobbox","x":"/a/jobbox"}{"cwd":"/a/jobbox/wrap"}{"cwd":"/a/jobbox2"}{"cwd":"/a/jobboxes/q"}`;
    const r = rewriteFieldPaths(text, ["cwd"], "/a/jobbox", "/b/jobbox");
    assert.equal(r.count, 2);
    assert.equal(r.text, `{"cwd":"/b/jobbox","x":"/a/jobbox"}{"cwd":"/b/jobbox/wrap"}{"cwd":"/a/jobbox2"}{"cwd":"/a/jobboxes/q"}`);
    const json: Record<string, unknown> = { projects: { "/a/jobbox": 1, "/a/jobbox/wrap": 2, "/a/jobbox2": 3 } };
    assert.equal(rewriteClaudeJsonProjects(json, "/a/jobbox", "/b/jobbox"), 2);
    assert.deepEqual(Object.keys(json.projects as object).sort(), ["/a/jobbox2", "/b/jobbox", "/b/jobbox/wrap"]);
});

test("a dry run lists everything and changes nothing", () => {
    const m = machine();
    const before = readFileSync(join(m.claudeDir, "history.jsonl"), "utf8");
    const plan = planRelocate(m.oldDir, m.newDir, m.env);
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.transcriptDirs.length, 2, "the folder's own history and its subfolder's, not the sibling's");
    assert.ok(plan.rewrites.some((r) => r.kind === "history" && r.count === 2));
    assert.ok(plan.rewrites.some((r) => r.kind === "claude-json" && r.count === 1));
    assert.ok(plan.rewrites.some((r) => r.kind === "plate" && r.count === 2));
    assert.equal(plan.links.length, 1);
    assert.deepEqual(plan.references, [join(m.ws, "jobbox.code-workspace")]);
    assert.ok(existsSync(m.oldDir) && !existsSync(m.newDir));
    assert.equal(readFileSync(join(m.claudeDir, "history.jsonl"), "utf8"), before);
});

test("apply moves the folder and every piece of state, and leaves the sibling alone", () => {
    const m = machine();
    const r = applyRelocate(planRelocate(m.oldDir, m.newDir, m.env), { fixLinks: true });
    assert.equal(r.moved, true);
    assert.deepEqual(r.skipped, []);
    assert.ok(existsSync(join(m.newDir, "Cargo.toml")) && !existsSync(m.oldDir));

    const newKeyDir = join(m.claudeDir, "projects", claudeProjectKey(m.newDir));
    const transcript = readFileSync(join(newKeyDir, "s1.jsonl"), "utf8");
    assert.ok(!transcript.includes(`"cwd":"${m.oldDir}`), "no cwd left on the old path");
    assert.ok(transcript.includes(`cd ${m.oldDir} && ls`), "what was typed is not rewritten");
    assert.ok(existsSync(join(m.claudeDir, "projects", claudeProjectKey(join(m.newDir, "wrap")), "s1.jsonl")));
    assert.ok(existsSync(join(m.claudeDir, "projects", claudeProjectKey(m.sibling), "s1.jsonl")), "the sibling's history stays");
    assert.ok(existsSync(join(m.claudeDir, "projects", claudeProjectKey(m.lookalike), "s1.jsonl")), "a look-alike key whose cwd is elsewhere stays");

    const history = readFileSync(join(m.claudeDir, "history.jsonl"), "utf8");
    assert.ok(history.includes(`"project":"${m.newDir}"`) && history.includes(`"project":"${join(m.newDir, "wrap")}"`));
    assert.ok(history.includes(`"project":"${m.sibling}"`));
    const cj = JSON.parse(readFileSync(m.claudeJson, "utf8")) as { projects: Record<string, { hasTrustDialogAccepted: boolean }>; numStartups: number };
    assert.equal(cj.projects[m.newDir]?.hasTrustDialogAccepted, true, "trust follows the folder");
    assert.equal(cj.projects[m.sibling]?.hasTrustDialogAccepted, false);
    assert.equal(cj.numStartups, 3);
    assert.equal((JSON.parse(readFileSync(join(m.loopRoot, "cl-jobbox-1", "plate.json"), "utf8")) as { cwd: string }).cwd, m.newDir);
    assert.equal(readlinkSync(join(m.bin, "jb-link")), join(m.newDir, "Cargo.toml"));
    assert.ok(r.rewritten.every((w) => existsSync(w.backup)), "every rewrite kept its backup");
    assert.ok(readFileSync(join(m.ws, "jobbox.code-workspace"), "utf8").includes("BookShepherd/jobbox"), "references are reported, never rewritten");
});

test("--state-only catches up a folder already moved by hand", () => {
    const m = machine();
    renameSync(m.oldDir, m.newDir);
    assert.match(planRelocate(m.oldDir, m.newDir, m.env).blockers.join("\n"), /--state-only/);
    const plan = planRelocate(m.oldDir, m.newDir, m.env, { stateOnly: true });
    assert.deepEqual(plan.blockers, []);
    const r = applyRelocate(plan);
    assert.equal(r.moved, false);
    assert.ok(readFileSync(join(m.claudeDir, "history.jsonl"), "utf8").includes(`"project":"${m.newDir}"`));
});

test("--state-only also finishes a move whose history directory was renamed by hand but not rewritten", () => {
    const m = machine();
    renameSync(m.oldDir, m.newDir);
    const projects = join(m.claudeDir, "projects");
    renameSync(join(projects, claudeProjectKey(m.oldDir)), join(projects, claudeProjectKey(m.newDir)));
    const plan = planRelocate(m.oldDir, m.newDir, m.env, { stateOnly: true });
    assert.deepEqual(plan.blockers, []);
    assert.ok(plan.rewrites.some((r) => r.kind === "transcript" && r.file.startsWith(join(projects, claudeProjectKey(m.newDir))) && r.count === 3));
    applyRelocate(plan);
    const transcript = readFileSync(join(projects, claudeProjectKey(m.newDir), "s1.jsonl"), "utf8");
    assert.ok(!transcript.includes(`"cwd":"${m.oldDir}`));
});

test("refuses while a loop or a process runs in the old folder, or a claude session in the new one", () => {
    const withLoop = machine({ alive: [4242] });
    assert.match(planRelocate(withLoop.oldDir, withLoop.newDir, withLoop.env).blockers.join("\n"), /loop cl-jobbox-1 is running/);

    const busy = machine();
    busy.env.processCwds = () => [{ pid: 7, cwd: join(busy.oldDir, "wrap"), cmd: "cargo watch" }];
    const plan = planRelocate(busy.oldDir, busy.newDir, busy.env);
    assert.match(plan.blockers.join("\n"), /process 7 \(cargo watch\)/);
    assert.throws(() => applyRelocate(plan), /cannot relocate/);
    assert.ok(existsSync(busy.oldDir), "nothing moved");
});

test("a file that changes while it is rewritten is left alone and reported", () => {
    const m = machine();
    const plan = planRelocate(m.oldDir, m.newDir, m.env);
    // Simulate a Claude session appending between the plan and the apply — the
    // rewrite reads, then finds the file moved on under it.
    const history = join(m.claudeDir, "history.jsonl");
    const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
    const realCopy = fs.copyFileSync;
    fs.copyFileSync = ((src: string, dest: string) => {
        realCopy(src, dest);
        if (src === history) fs.appendFileSync(history, `{"display":"late","project":"${m.oldDir}"}\n`);
    }) as typeof fs.copyFileSync;
    syncBuiltinESMExports();
    try {
        const r = applyRelocate(plan);
        assert.ok(r.skipped.some((s) => s.file === history && /changed while/.test(s.reason)));
        assert.ok(readFileSync(history, "utf8").includes(`{"display":"late"`), "the late line survives");
    } finally {
        fs.copyFileSync = realCopy;
        syncBuiltinESMExports();
    }
});
