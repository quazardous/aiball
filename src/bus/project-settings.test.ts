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
// #3305 — the machine's layer (claude_loop.session) is read from here, not the user's.
process.env.XDG_CONFIG_HOME = join(home, "xdg");
const { getMethod } = await import("./methods.js");
await import("./register.js");
after(() => rmSync(home, { recursive: true, force: true }));

const settings = getMethod("project.settings")!;
const settingsSet = getMethod("project.settings_set")!;
const human = testCaller("boss", { kind: "human" });
type Settings = {
    file: string | null;
    configured: boolean;
    consumer: { project: { value: string; from: string }; agent: { value: string; from: string }; role: { value: string | null; from: string } };
    session: { value: string; from: string };
    remote_control: { value: boolean | string; from: string };
};
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
    const r = read(d);
    assert.deepEqual([r.file, r.remote_control], [join(d, ".aiball.yaml"), { value: false, from: "default" }]);
    const e = folder("claude:\n  remote_control: phone\n");
    assert.deepEqual(read(e).remote_control, { value: "phone", from: "file" });
    const bare = read(folder());
    assert.deepEqual([bare.file, bare.remote_control], [null, { value: false, from: "default" }], "no file at all");
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

// #3305 — what a client setting the folder up starts from: every value, and where it comes from.
test("the folder's resolved configuration: identity, where it runs, each with where it comes from", () => {
    const d = folder("consumer:\n  project: proj-3305\n  agent: proj-claude\n  role: crew\nclaude_loop:\n  session: tmux\n");
    const r = read(d);
    assert.equal(r.configured, true);
    assert.deepEqual(r.consumer, {
        project: { value: "proj-3305", from: "file" },
        agent: { value: "proj-claude", from: "file" },
        role: { value: "crew", from: "file" },
    });
    assert.deepEqual(r.session, { value: "tmux", from: "file" });

    // A bare folder: the defaults, and it says so.
    const bare = folder();
    const b = read(bare);
    assert.equal(b.configured, false);
    assert.deepEqual(b.consumer.project.from, "default");
    assert.deepEqual(b.consumer.role, { value: null, from: "default" });
    assert.deepEqual(b.session, { value: "host", from: "default" });

    // The machine's layer: the global config's session, unless the file says otherwise.
    mkdirSync(join(home, "xdg", "aiball"), { recursive: true });
    writeFileSync(join(home, "xdg", "aiball", "config.yaml"), "claude_loop:\n  session: tmux\n");
    try {
        assert.deepEqual(read(bare).session, { value: "tmux", from: "global" });
        assert.deepEqual(read(d).session, { value: "tmux", from: "file" });
    } finally {
        rmSync(join(home, "xdg", "aiball", "config.yaml"));
    }
});

test("set writes where loops run, in place; null hands it back to the layer below", () => {
    const d = folder(YAML);
    assert.deepEqual(set({ cwd: d, session: "tmux" }).session, { value: "tmux", from: "file" });
    const text = readFileSync(join(d, ".aiball.yaml"), "utf8");
    assert.match(text, /# my notes/);
    assert.match(text, /claude_loop:\n {2}session: tmux/);
    assert.deepEqual(set({ cwd: d, session: null }).session, { value: "host", from: "default" });
    assert.equal(readFileSync(join(d, ".aiball.yaml"), "utf8"), YAML, "back to the file as it was");
});

// #3308 — an emptied file is not left `{}`; the settings are described, and set by key.
test("a file emptied by set is not written {}: its leading comments stay, else it is empty", () => {
    const bare = folder("claude_loop:\n  session: tmux\n");
    set({ cwd: bare, session: null });
    assert.equal(readFileSync(join(bare, ".aiball.yaml"), "utf8"), "");
    const noted = folder("# my notes\n# more\nclaude_loop:\n  session: tmux\n");
    set({ cwd: noted, session: null });
    assert.equal(readFileSync(join(noted, ".aiball.yaml"), "utf8"), "# my notes\n# more\n");
});

test("the settings are described, each with its type, choices, default, value and where it comes from", () => {
    const d = folder("claude_loop:\n  session: tmux\n");
    const r = settings.run(human, { cwd: d }) as Settings & { settings: { key: string; type: string; options?: string[]; default: unknown; value: unknown; from: string; label: string }[] };
    assert.deepEqual(r.settings.map((s) => s.key), ["claude_loop.session", "claude.remote_control"]);
    const session = r.settings[0]!;
    assert.deepEqual([session.type, session.options, session.value, session.from], ["enum", ["host", "tmux"], "tmux", "file"]);
    assert.equal(typeof session.label, "string");
    assert.deepEqual([r.settings[1]!.type, r.settings[1]!.value, r.settings[1]!.from], ["boolean_or_name", false, "default"]);
});

test("set by key writes what the named field writes; an unknown key or a value out of its type is refused", () => {
    const a = folder(YAML);
    const b = folder(YAML);
    set({ cwd: a, session: "tmux" });
    set({ cwd: b, key: "claude_loop.session", value: "tmux" });
    assert.equal(readFileSync(join(a, ".aiball.yaml"), "utf8"), readFileSync(join(b, ".aiball.yaml"), "utf8"));
    assert.deepEqual(set({ cwd: b, key: "claude.remote_control", value: "phone" }).remote_control, { value: "phone", from: "file" });
    assert.deepEqual(set({ cwd: b, key: "claude_loop.session", value: null }).session.from, "default");
    assert.throws(() => set({ cwd: b, key: "claude.model", value: "x" }), (e: { code: string }) => e.code === "BAD_REQUEST");
    assert.throws(() => set({ cwd: b, key: "claude_loop.session", value: "screen" }), (e: { code: string }) => e.code === "BAD_REQUEST");
});

// #3327 — removing a block no longer takes the comment written above it (yaml attaches the file's header to the first key).
test("removing the first block keeps the file's header, above what stays", () => {
    const d = folder("# header one\n# header two\nclaude_loop:\n  session: tmux\nconsumer:\n  agent: a-3327\n");
    set({ cwd: d, session: null });
    assert.equal(readFileSync(join(d, ".aiball.yaml"), "utf8"), "# header one\n# header two\nconsumer:\n  agent: a-3327\n");
});

test("a file emptied keeps its header glued to the removed block; a key's own comment moves to the block's next key", () => {
    const glued = folder("# only header\nclaude_loop:\n  session: tmux\n");
    set({ cwd: glued, session: null });
    assert.equal(readFileSync(join(glued, ".aiball.yaml"), "utf8"), "# only header\n");
    const keyed = folder("claude:\n  # the phone\n  remote_control: phone\n  deny_tools: [Bash]\n");
    set({ cwd: keyed, remote_control: null });
    assert.match(readFileSync(join(keyed, ".aiball.yaml"), "utf8"), /# the phone\n {2}deny_tools/);
});
