// #2466 — `aiball backup` / `aiball restore`, on temporary homes only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = mkdtempSync(join(tmpdir(), "aiball-2466-"));
process.env.AIBALL_HOME = join(ROOT, "live-home");
process.env.AIBALL_SOCK = "";
process.env.XDG_CONFIG_HOME = join(ROOT, "live-config");
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { getDb, migrationsFolder } = await import("./db/connection.js");
const { submitMessage } = await import("./messages.js");
const { createProject } = await import("./db/projects.js");
const { applyRestore, createBackup, readKnownMigrations, verifyBackup } = await import("./backup.js");
const Database = (await import("better-sqlite3")).default;

const HOME = process.env.AIBALL_HOME;
const CONFIG = join(process.env.XDG_CONFIG_HOME, "aiball");
const KNOWN = readKnownMigrations(migrationsFolder());
const NODE_MODULES = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules");

getDb();
createProject({ name: "p-2466" });
for (let i = 0; i < 20; i++) {
    const t = submitMessage({ project: "p-2466", kind: "ticket_created", title: `t${i}`, body: "x", by_agent: "boss" });
    submitMessage({ project: "p-2466", kind: "comment_added", ticket_id: t.id, parent_id: t.id, body: `c${i}`, by_agent: "boss" });
}
mkdirSync(join(HOME, "uploads"), { recursive: true });
writeFileSync(join(HOME, "uploads", "abc.png"), "fake image");
writeFileSync(join(HOME, "cli-env"), "AIBALL_TOKEN=secret\n");
writeFileSync(join(HOME, "daemon.pid"), "123");
mkdirSync(CONFIG, { recursive: true });
writeFileSync(join(CONFIG, "config.yaml"), "assign_window_sec: 14400\n");

let n = 0;
const dest = () => join(ROOT, `backup-${++n}`);
const count = (db: string, table: string): number => {
    const d = new Database(db, { readonly: true });
    try { return (d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; } finally { d.close(); }
};

test("a backup taken while another process writes in a loop is a consistent snapshot", async () => {
    const before = count(join(HOME, "aiball.db"), "tickets");
    // A real concurrent writer: another process, on the live file, in WAL mode.
    const writer = spawn(process.execPath, ["-e", `
        const D = require(${JSON.stringify(join(NODE_MODULES, "better-sqlite3"))});
        const db = new D(${JSON.stringify(join(HOME, "aiball.db"))});
        db.pragma("journal_mode = WAL");
        db.exec("CREATE TABLE IF NOT EXISTS load_2466 (id INTEGER PRIMARY KEY, v TEXT)");
        const ins = db.prepare("INSERT INTO load_2466 (v) VALUES (?)");
        const end = Date.now() + 1500;
        process.stdout.write("go\\n");
        while (Date.now() < end) db.transaction(() => { for (let i = 0; i < 50; i++) ins.run("x".repeat(200)); })();
    `], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((r) => writer.stdout!.once("data", () => r()));
    const out = dest();
    const m = await createBackup({ home: HOME, configDir: CONFIG, dest: out, aiballVersion: "test" });
    await new Promise<void>((r) => writer.once("exit", () => r()));
    assert.ok(count(join(HOME, "aiball.db"), "load_2466") > 0, "precondition: the writer did write");

    const snap = join(out, "aiball.db");
    const d = new Database(snap, { readonly: true });
    try {
        assert.equal((d.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
        assert.equal((d.pragma("journal_mode", { simple: true }) as string).toLowerCase(), "delete", "one self-contained file");
    } finally { d.close(); }
    assert.ok(!existsSync(`${snap}-wal`));
    assert.equal(m.row_counts.tickets, before);
    assert.equal(count(snap, "tickets"), before);
    // The manifest's counts are the snapshot's, not the live base's that moved on.
    if (m.row_counts.load_2466 !== undefined) assert.equal(m.row_counts.load_2466, count(snap, "load_2466"));
    assert.deepEqual(verifyBackup(out, KNOWN).errors, []);
});

test("the backup holds the data and the config, without runtime handles, privately", async () => {
    const out = dest();
    const m = await createBackup({ home: HOME, configDir: CONFIG, dest: out, aiballVersion: "test" });
    assert.ok(m.files["home/uploads/abc.png"]);
    assert.ok(m.files["home/cli-env"]);
    assert.ok(m.files["config/config.yaml"]);
    assert.equal(m.files["home/daemon.pid"], undefined);
    assert.equal(m.files["home/aiball.db-wal"], undefined);
    assert.equal(m.schema.migration_created_at, Math.max(...KNOWN));
    assert.equal(statSync(out).mode & 0o777, 0o700);
    assert.equal(statSync(join(out, "home", "cli-env")).mode & 0o777, 0o600);
});

test("a backup refuses a non-empty directory and one inside the home", async () => {
    const out = dest();
    mkdirSync(out);
    writeFileSync(join(out, "x"), "x");
    await assert.rejects(createBackup({ home: HOME, configDir: CONFIG, dest: out, aiballVersion: "t" }), /not empty/);
    await assert.rejects(createBackup({ home: HOME, configDir: CONFIG, dest: join(HOME, "bk"), aiballVersion: "t" }), /copy itself/);
});

test("restore on a blank install brings back the same tickets, threads, uploads and config, and sets the old aside", async () => {
    const out = dest();
    const m = await createBackup({ home: HOME, configDir: CONFIG, dest: out, aiballVersion: "test" });
    const target = { home: join(ROOT, "blank", "home"), configDir: join(ROOT, "blank", "config", "aiball") };
    mkdirSync(target.home, { recursive: true });
    writeFileSync(join(target.home, "stale.txt"), "old install");

    const { manifest, errors } = verifyBackup(out, KNOWN);
    assert.deepEqual(errors, []);
    const r = applyRestore({ ...target, src: out, manifest: manifest! });

    assert.ok(r.setAside.home && existsSync(join(r.setAside.home, "stale.txt")), "the previous home is kept");
    assert.equal(r.setAside.config, null, "no previous config to set aside");
    assert.equal(count(join(target.home, "aiball.db"), "tickets"), m.row_counts.tickets);
    assert.equal(count(join(target.home, "aiball.db"), "_messages"), m.row_counts._messages);
    assert.equal(readFileSync(join(target.home, "uploads", "abc.png"), "utf8"), "fake image");
    assert.equal(readFileSync(join(target.configDir, "config.yaml"), "utf8"), "assign_window_sec: 14400\n");
    assert.ok(!existsSync(join(target.home, "stale.txt")));
});

test("restore refuses an altered backup, a missing file, and a schema newer than the install", async () => {
    const altered = dest();
    await createBackup({ home: HOME, configDir: CONFIG, dest: altered, aiballVersion: "t" });
    writeFileSync(join(altered, "config", "config.yaml"), "assign_window_sec: 1\n");
    assert.match(verifyBackup(altered, KNOWN).errors.join("\n"), /altered: config\/config\.yaml/);

    const missing = dest();
    await createBackup({ home: HOME, configDir: CONFIG, dest: missing, aiballVersion: "t" });
    rmSync(join(missing, "home", "uploads", "abc.png"));
    assert.match(verifyBackup(missing, KNOWN).errors.join("\n"), /missing: home\/uploads\/abc\.png/);

    const newer = dest();
    await createBackup({ home: HOME, configDir: CONFIG, dest: newer, aiballVersion: "t" });
    assert.match(verifyBackup(newer, KNOWN.slice(0, -1)).errors.join("\n"), /newer than this install/);

    const escape = dest();
    const m = await createBackup({ home: HOME, configDir: CONFIG, dest: escape, aiballVersion: "t" });
    m.files["home/../../evil"] = "0";
    writeFileSync(join(escape, "manifest.json"), JSON.stringify(m));
    assert.match(verifyBackup(escape, KNOWN).errors.join("\n"), /unexpected path/);
});
