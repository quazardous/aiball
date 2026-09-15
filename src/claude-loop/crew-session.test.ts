/**
 * #2523 — a crew agent next to the main loop in one folder: one session file
 * holding both sessions, each loop resuming its own, a crew that may start from
 * a fork of the main loop's, and a boot reminder that tells a crew it waits.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    parseSessionFile,
    recordSessionEntry,
    resolveSession,
    sessionEntry,
    sessionKeyFor,
    serializeSessionFile,
    withSessionEntry,
} from "./session-id.js";
import { bootReminderFor, CREW_BOOT_REMINDER } from "./loop-state.js";
import { loadPromptsFromYaml, mergePrompts, renderSlot } from "../prompt-templates.js";

const LEAD = "11111111-2222-4333-8444-555555555555";
const CREW = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CLEARED = "99999999-8888-4777-8666-555555555555";
const DIR = mkdtempSync(join(tmpdir(), "aiball-2523-"));
after(() => rmSync(DIR, { recursive: true, force: true }));

test("the main loop keys `default`, a crew agent its own name", () => {
    assert.equal(sessionKeyFor(null, "aiball-claude"), "default");
    assert.equal(sessionKeyFor("lead", "aiball-claude"), "default");
    assert.equal(sessionKeyFor("crew", "reviewer"), "agent:reviewer");
});

test("an old file holding one bare id reads as the main loop's session", () => {
    const { file, corrupt } = parseSessionFile(`${LEAD}\n`);
    assert.equal(corrupt, false);
    assert.equal(sessionEntry(file, "default"), LEAD);
    assert.equal(sessionEntry(file, "agent:reviewer"), null);
});

test("setting one entry keeps every other, and the file round-trips", () => {
    const f = withSessionEntry(withSessionEntry(parseSessionFile(LEAD).file, "agent:reviewer", CREW), "agent:doc", CLEARED);
    const back = parseSessionFile(serializeSessionFile(f)).file;
    assert.equal(sessionEntry(back, "default"), LEAD);
    assert.equal(sessionEntry(back, "agent:reviewer"), CREW);
    assert.equal(sessionEntry(back, "agent:doc"), CLEARED);
    assert.deepEqual(JSON.parse(serializeSessionFile(f)), { default: LEAD, agents: { reviewer: CREW, doc: CLEARED } });
});

test("an unreadable file is empty and flagged, never a crash", () => {
    for (const text of ["{not json", "[1,2]", "\"just a string\""]) {
        const { file, corrupt } = parseSessionFile(text);
        assert.equal(corrupt, true, text);
        assert.equal(sessionEntry(file, "default"), null);
    }
});

test("the hook's write keeps the entry another loop wrote, even from another process at the same time", async () => {
    const path = join(DIR, "concurrent.json");
    writeFileSync(path, `${LEAD}\n`);
    recordSessionEntry(path, "agent:reviewer", CREW);
    const HERE = fileURLToPath(new URL(".", import.meta.url));
    // Two processes record different agents 50 times each, interleaved.
    const writer = (agent: string, id: string) => new Promise<void>((resolve, reject) => {
        const p = spawn(process.execPath, ["--import", "tsx", "-e", `
            const { recordSessionEntry } = await import(${JSON.stringify(join(HERE, "session-id.ts"))});
            for (let i = 0; i < 50; i++) recordSessionEntry(${JSON.stringify(path)}, ${JSON.stringify(agent)}, ${JSON.stringify(id)});
        `], { stdio: "inherit" });
        p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
    });
    await Promise.all([writer("agent:a", CLEARED), writer("agent:b", LEAD), writer("agent:c", CREW)]);
    const file = parseSessionFile(readFileSync(path, "utf8")).file;
    assert.equal(sessionEntry(file, "default"), LEAD, "the main loop's entry survived");
    assert.equal(sessionEntry(file, "agent:reviewer"), CREW, "the earlier crew entry survived");
    assert.equal(sessionEntry(file, "agent:a"), CLEARED, "writer a's entry survived writer b");
    assert.equal(sessionEntry(file, "agent:b"), LEAD, "writer b's entry survived writer a");
    assert.equal(sessionEntry(file, "agent:c"), CREW, "writer c's entry survived both");
});

test("a crew resumes its own session, never the main loop's; with none it starts fresh", () => {
    const exists = (id: string) => [LEAD, CREW].includes(id);
    const file = withSessionEntry(parseSessionFile(LEAD).file, "agent:reviewer", CREW);
    const own = resolveSession({ mode: "auto", configuredId: "", loopName: "x", sessionExists: exists, readPersistedId: () => sessionEntry(file, "agent:reviewer") });
    assert.deepEqual(own.args, ["--resume", CREW]);

    const none = resolveSession({ mode: "auto", configuredId: "", loopName: "x", sessionExists: exists, readPersistedId: () => sessionEntry(file, "agent:doc") });
    assert.deepEqual(none.args, [], "no entry: a new session, not the main loop's");
});

test("after a /clear the hook records the new id, and the next start resumes it", () => {
    const path = join(DIR, "clear.json");
    recordSessionEntry(path, "default", LEAD);
    recordSessionEntry(path, "agent:reviewer", CREW);
    recordSessionEntry(path, "agent:reviewer", CLEARED); // SessionStart source=clear
    const file = parseSessionFile(readFileSync(path, "utf8")).file;
    const plan = resolveSession({ mode: "auto", configuredId: "", loopName: "x", sessionExists: () => true, readPersistedId: () => sessionEntry(file, "agent:reviewer") });
    assert.deepEqual(plan.args, ["--resume", CLEARED]);
    assert.equal(sessionEntry(file, "default"), LEAD);
});

test("--fork: with no session of its own, a crew starts from a fork of the main loop's", () => {
    const exists = (id: string) => id === LEAD;
    const fork = resolveSession({ mode: "auto", configuredId: "", loopName: "x", sessionExists: exists, readPersistedId: () => null, forkFrom: LEAD });
    assert.deepEqual(fork.args, ["--resume", LEAD, "--fork-session"]);

    const already = resolveSession({ mode: "auto", configuredId: "", loopName: "x", sessionExists: () => true, readPersistedId: () => CREW, forkFrom: LEAD });
    assert.deepEqual(already.args, ["--resume", CREW], "once it has its own session, the fork is not repeated");

    const gone = resolveSession({ mode: "auto", configuredId: "", loopName: "x", sessionExists: () => false, readPersistedId: () => null, forkFrom: LEAD });
    assert.deepEqual(gone.args, []);
    assert.match(gone.warning ?? "", /no session to fork/);
});

test("a crew's boot reminder says who it is and that it waits; never the triage", () => {
    const shipped = mergePrompts(loadPromptsFromYaml(fileURLToPath(new URL("../../config/defaults/claude-loop-pings.yaml", import.meta.url))), {});
    const crew = bootReminderFor("crew");
    const text = renderSlot(shipped, crew.slot, { agent: "reviewer" }, crew.fallback);
    assert.match(text, /^You are the crew agent reviewer\. You wait for explicit requests/);
    assert.doesNotMatch(text, /triage/i);
    assert.equal(renderSlot({}, crew.slot, { agent: "reviewer" }, crew.fallback), renderSlot(shipped, crew.slot, { agent: "reviewer" }, crew.fallback),
        "a loop whose pings copy predates the slot gets the same words");
    assert.equal(CREW_BOOT_REMINDER, shipped.post_boot_crew_reminder, "the shipped slot and the code fallback say the same");

    const lead = bootReminderFor(null);
    assert.match(renderSlot(shipped, lead.slot, {}, lead.fallback), /triage your queue/);
});

/** Run `claude-loop start …` in a scratch project, with the loop shell's identity scrubbed. */
function startCli(args: string[], yaml: string): { code: number | null; stderr: string } {

    const project = mkdtempSync(join(DIR, "proj-"));
    writeFileSync(join(project, ".aiball.yaml"), yaml);
    const env: NodeJS.ProcessEnv = { ...process.env, AIBALL_SOCK: "", AIBALL_HOME: join(DIR, "home"), CLAUDE_LOOP_STATE_ROOT: join(DIR, "loops") };
    for (const k of ["AIBALL_AGENT", "AIBALL_PROJECT", "AIBALL_CWD", "AIBALL_ROLE", "CL_STATE_DIR", "AIBALL_PROJECT_CWD"]) delete env[k];
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const r = spawnSync(process.execPath, ["--import", "tsx", cli, "start", "--cwd", project, ...args], { env, encoding: "utf8", timeout: 30_000 });
    return { code: r.status, stderr: r.stderr };
}

test("--crew refuses the folder's main agent's own name, and --fork without --crew, before touching anything", () => {
    const yaml = "consumer:\n  agent: shop-claude\n  project: shop\n";
    const same = startCli(["--crew", "shop-claude"], yaml);
    assert.equal(same.code, 1, same.stderr);
    assert.match(same.stderr, /--crew shop-claude: that is this folder's main agent/);

    const fork = startCli(["--fork"], yaml);
    assert.equal(fork.code, 1, fork.stderr);
    assert.match(fork.stderr, /--fork goes with --crew/);

    const clash = startCli(["--crew", "reviewer", "--agent", "other"], yaml);
    assert.equal(clash.code, 1, clash.stderr);
    assert.match(clash.stderr, /name two different agents/);
});

test("a writer waits while another loop holds the lock, then keeps both entries", async () => {
    const path = join(DIR, "locked.json");
    writeFileSync(path, serializeSessionFile(withSessionEntry(parseSessionFile(null).file, "default", LEAD)));
    writeFileSync(`${path}.lock`, ""); // another loop mid-write
    const HERE = fileURLToPath(new URL(".", import.meta.url));
    const p = spawn(process.execPath, ["--import", "tsx", "-e", `
        const { recordSessionEntry } = await import(${JSON.stringify(join(HERE, "session-id.ts"))});
        recordSessionEntry(${JSON.stringify(path)}, "agent:reviewer", ${JSON.stringify(CREW)});
    `], { stdio: "inherit" });
    const exited = new Promise<number | null>((r) => p.on("exit", r));
    await new Promise((r) => setTimeout(r, 1200)); // tsx boot + well inside the 2 s wait
    assert.equal(sessionEntry(parseSessionFile(readFileSync(path, "utf8")).file, "agent:reviewer"), null, "no write while the lock is held");
    // The holder finishes: it wrote its own entry, then released.
    writeFileSync(path, serializeSessionFile(withSessionEntry(parseSessionFile(readFileSync(path, "utf8")).file, "agent:doc", CLEARED)));
    rmSync(`${path}.lock`);
    assert.equal(await exited, 0);
    const file = parseSessionFile(readFileSync(path, "utf8")).file;
    assert.equal(sessionEntry(file, "agent:reviewer"), CREW);
    assert.equal(sessionEntry(file, "agent:doc"), CLEARED, "the holder's entry was read after the lock, not overwritten");
    assert.equal(sessionEntry(file, "default"), LEAD);
});
