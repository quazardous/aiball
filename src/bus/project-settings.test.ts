// #3256 — project.settings / project.settings_set: a project's settings a client shows and changes, in the `.aiball.yaml` its loops read, patched in place.
import { test, after } from "node:test";
import { refused, testCaller } from "../tests/lib.js";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-3256-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
const { getMethod } = await import("./methods.js");
await import("./register.js");
after(() => rmSync(home, { recursive: true, force: true }));

const settings = getMethod("project.settings")!;
const settingsSet = getMethod("project.settings_set")!;
const human = testCaller("boss", { kind: "human" });
type Settings = { file: string | null; remote_control: { value: boolean | string; from: string } };
const read = (cwd: string, caller = human) => settings.run(caller, { cwd }) as Settings;
const set = (p: Record<string, unknown>, caller = human) => settingsSet.run(caller, p) as Settings;
let n = 0;
const folder = (yaml?: string) => {
    const d = join(home, `f${n++}`);
    mkdirSync(d);
    if (yaml !== undefined) writeFileSync(join(d, ".aiball.yaml"), yaml);
    return d;
};

const YAML = "# my notes\nconsumer:\n  agent: a-3256 # who\nautopoll:\n  enabled: true\n";

test("read: the default when the file says nothing, the file's value when it does, and which file", () => {
    const d = folder(YAML);
    assert.deepEqual(read(d), { file: join(d, ".aiball.yaml"), remote_control: { value: false, from: "default" } });
    const e = folder("claude:\n  remote_control: phone\n");
    assert.deepEqual(read(e).remote_control, { value: "phone", from: "file" });
    assert.deepEqual(read(folder()), { file: null, remote_control: { value: false, from: "default" } }, "no file at all");
});

test("a sub-folder reads, and patches, the file its loops read: the nearest one up the tree", () => {
    const d = folder(YAML);
    const sub = join(d, "src", "deep");
    mkdirSync(sub, { recursive: true });
    const r = set({ cwd: sub, remote_control: true });
    assert.equal(r.file, join(d, ".aiball.yaml"), "not a new file in the sub-folder, which would hide the parent's");
    assert.deepEqual(r.remote_control, { value: true, from: "file" });
});

test("set patches in place: other keys and comments stay; null removes the key and the emptied block", () => {
    const d = folder(YAML);
    const r = set({ cwd: d, remote_control: "phone" });
    assert.deepEqual(r.remote_control, { value: "phone", from: "file" });
    const text = readFileSync(join(d, ".aiball.yaml"), "utf8");
    assert.match(text, /# my notes/);
    assert.match(text, /agent: a-3256 # who/);
    assert.match(text, /claude:\n {2}remote_control: phone/);
    assert.deepEqual(set({ cwd: d, remote_control: false }).remote_control, { value: false, from: "file" }, "false is a value the file says");
    assert.deepEqual(set({ cwd: d, remote_control: null }).remote_control, { value: false, from: "default" });
    assert.equal(readFileSync(join(d, ".aiball.yaml"), "utf8"), YAML, "back to the file as it was");
});

test("set leaves the other keys of an existing claude block alone", () => {
    const d = folder("claude:\n  always_resume: false\n");
    set({ cwd: d, remote_control: true });
    set({ cwd: d, remote_control: null });
    assert.equal(readFileSync(join(d, ".aiball.yaml"), "utf8"), "claude:\n  always_resume: false\n");
});

test("refusals, with their code: no folder, a relative path, no file to patch, a file that is not YAML, a non-mapping claude", async () => {
    assert.equal((await refused(() => read(join(home, "none")))).code, "NOT_FOUND");
    assert.equal((await refused(() => set({ cwd: "relative/dir", remote_control: true }))).code, "BAD_REQUEST");
    const bare = folder();
    const noFile = await refused(() => set({ cwd: bare, remote_control: true }));
    assert.equal(noFile.code, "CONFLICT");
    assert.match(noFile.message, /project\.init/);
    assert.equal((await refused(() => read(folder("a: [b\n")))).code, "CONFLICT");
    assert.equal((await refused(() => set({ cwd: folder("claude: 3\n"), remote_control: true }))).code, "CONFLICT");
});

test("a file the daemon may not write: 403, and it is left as it was", { skip: process.getuid?.() === 0 ? "root writes everywhere" : false }, async () => {
    const d = folder(YAML);
    const file = join(d, ".aiball.yaml");
    chmodSync(file, 0o444);
    try {
        assert.equal((await refused(() => set({ cwd: d, remote_control: true }))).status, 403);
        assert.equal(readFileSync(file, "utf8"), YAML);
    } finally {
        chmodSync(file, 0o644);
    }
});

test("a human's gesture on this machine: not over TCP, not an agent's; and a name, not a flag", async () => {
    const d = folder(YAML);
    assert.equal((await refused(() => read(d, testCaller("boss", { kind: "human", transport: "tcp" })))).status, 403);
    assert.equal((await refused(() => set({ cwd: d, remote_control: true }, testCaller("boss", { kind: "human", transport: "tcp" })))).status, 403);
    for (const m of [settings, settingsSet]) assert.deepEqual(m.who, ["human"], `${m.name} is a human's`);
    assert.equal(settingsSet.params.safeParse({ cwd: d, remote_control: "--model" }).success, false);
    assert.equal(settingsSet.params.safeParse({ cwd: d, remote_control: null }).success, true);
});
