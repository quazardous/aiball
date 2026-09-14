/**
 * `aiball backup` / `aiball restore` (#2466).
 *
 * A `cp` of `aiball.db` while the daemon runs copies the file and its WAL at
 * two different instants, and the result can be inconsistent. The layout of
 * what is data (the database, uploads, spool, the global config) used to live
 * in whoever scripted the copy; it lives here now, next to the code that
 * decides it.
 *
 * The database is copied through SQLite's online backup on a READ-ONLY raw
 * connection — never `getDb()`, which runs the migrations when it opens: a
 * backup that migrated the live base would be worse than the `cp` it replaces.
 *
 * A backup is a directory:
 *
 *     aiball.db        the snapshot (integrity-checked, single file)
 *     home/…           everything else of $AIBALL_HOME that is data
 *     config/…         the global config directory (~/.config/aiball)
 *     manifest.json    versions, row counts, sha256 of every file above
 *
 * `restore` checks all of it before touching anything, refuses while the daemon
 * runs (stopping it cuts every loop — that is the operator's gesture), and sets
 * the current home and config aside instead of overwriting them.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MANIFEST = "manifest.json";
export const BACKUP_FORMAT = 1;

/** Entries of $AIBALL_HOME that are not data: runtime handles and the live DB files. */
const HOME_EXCLUDED = new Set(["sock", "daemon.pid", "aiball.db", "aiball.db-wal", "aiball.db-shm", "aiball.db-journal"]);

export interface BackupManifest {
    format: number;
    aiball_version: string;
    created_at: string;
    /** Latest applied drizzle migration (its journal `when`), null on a base without one. */
    schema: { migration_created_at: number | null; migration_hash: string | null };
    row_counts: Record<string, number>;
    /** Backup-relative path (posix separators) → sha256. */
    files: Record<string, string>;
}

export interface BackupPaths {
    /** $AIBALL_HOME */
    home: string;
    /** The global config directory (parent of config.yaml). */
    configDir: string;
}

function sha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function posix(p: string): string {
    return p.split(sep).join("/");
}

/** Regular files under `root`, recursively; sockets, symlinks and the rest are skipped. */
function listFiles(root: string, skipTop: (name: string) => boolean = () => false): string[] {
    const out: string[] = [];
    const walk = (dir: string, top: boolean): void => {
        for (const name of readdirSync(dir)) {
            if (top && skipTop(name)) continue;
            const full = join(dir, name);
            const st = lstatSync(full);
            if (st.isDirectory()) walk(full, false);
            else if (st.isFile()) out.push(full);
        }
    };
    if (existsSync(root)) walk(root, true);
    return out.sort();
}

function copyPrivate(src: string, dest: string): void {
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    copyFileSync(src, dest);
    chmodSync(dest, 0o600);
}

/** Row count per table, and the latest applied migration, of a SQLite file. */
function describeDb(path: string): { counts: Record<string, number>; schema: BackupManifest["schema"] } {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ).all() as Array<{ name: string }>;
        const counts: Record<string, number> = {};
        for (const { name } of tables) {
            counts[name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number }).n;
        }
        let schema: BackupManifest["schema"] = { migration_created_at: null, migration_hash: null };
        if (tables.some((t) => t.name === "__drizzle_migrations")) {
            const row = db.prepare(
                "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
            ).get() as { hash: string; created_at: number } | undefined;
            if (row) schema = { migration_created_at: Number(row.created_at), migration_hash: row.hash };
        }
        return { counts, schema };
    } finally {
        db.close();
    }
}

function integrityErrors(path: string): string[] {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
        return rows.map((r) => r.integrity_check).filter((m) => m !== "ok");
    } finally {
        db.close();
    }
}

export async function createBackup(input: BackupPaths & { dest: string; aiballVersion: string; now?: Date }): Promise<BackupManifest> {
    const { home, configDir, dest } = input;
    const dbPath = join(home, "aiball.db");
    if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
    for (const inside of [home, configDir]) {
        const rel = relative(resolve(inside), resolve(dest));
        if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
            throw new Error(`${dest} is inside ${inside} — the backup would copy itself`);
        }
    }
    if (existsSync(dest) && readdirSync(dest).length > 0) {
        throw new Error(`${dest} is not empty — a backup goes into a new or empty directory`);
    }
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    chmodSync(dest, 0o700);

    // 1. The database, through the online backup API: one consistent instant,
    //    whatever the daemon writes meanwhile.
    const snapshot = join(dest, "aiball.db");
    const live = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        await live.backup(snapshot);
    } finally {
        live.close();
    }
    // A backup of a WAL base is itself flagged WAL; make it one self-contained file.
    const copy = new Database(snapshot);
    try {
        copy.pragma("journal_mode = DELETE");
    } finally {
        copy.close();
    }
    chmodSync(snapshot, 0o600);
    const bad = integrityErrors(snapshot);
    if (bad.length > 0) throw new Error(`the snapshot fails integrity_check: ${bad.slice(0, 3).join("; ")}`);

    // 2. The rest of the home, and the global config.
    const files: Record<string, string> = { "aiball.db": sha256(snapshot) };
    for (const f of listFiles(home, (name) => HOME_EXCLUDED.has(name))) {
        const rel = `home/${posix(relative(home, f))}`;
        copyPrivate(f, join(dest, rel));
        files[rel] = sha256(join(dest, rel));
    }
    for (const f of listFiles(configDir)) {
        const rel = `config/${posix(relative(configDir, f))}`;
        copyPrivate(f, join(dest, rel));
        files[rel] = sha256(join(dest, rel));
    }

    const { counts, schema } = describeDb(snapshot);
    const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        aiball_version: input.aiballVersion,
        created_at: (input.now ?? new Date()).toISOString(),
        schema,
        row_counts: counts,
        files,
    };
    writeFileSync(join(dest, MANIFEST), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    return manifest;
}

export interface VerifyResult {
    manifest: BackupManifest | null;
    errors: string[];
}

/**
 * Everything `restore` needs to trust a backup, checked without writing a byte.
 * `knownMigrations` = the `when` of every migration this install ships.
 */
export function verifyBackup(src: string, knownMigrations: readonly number[]): VerifyResult {
    const errors: string[] = [];
    const manifestPath = join(src, MANIFEST);
    if (!existsSync(manifestPath)) return { manifest: null, errors: [`no ${MANIFEST} in ${src}`] };
    let manifest: BackupManifest;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
    } catch {
        return { manifest: null, errors: [`${MANIFEST} is not valid JSON`] };
    }
    if (manifest.format !== BACKUP_FORMAT) errors.push(`unknown backup format ${String(manifest.format)}`);
    if (!manifest.files || !manifest.files["aiball.db"]) errors.push("the manifest lists no database");

    for (const [rel, hash] of Object.entries(manifest.files ?? {})) {
        if (rel.split("/").includes("..") || !(rel === "aiball.db" || rel.startsWith("home/") || rel.startsWith("config/"))) {
            errors.push(`unexpected path in the manifest: ${rel}`);
            continue;
        }
        const path = join(src, ...rel.split("/"));
        if (!existsSync(path)) errors.push(`missing: ${rel}`);
        else if (sha256(path) !== hash) errors.push(`altered: ${rel} (sha256 differs from the manifest)`);
    }
    if (errors.length > 0) return { manifest, errors };

    const bad = integrityErrors(join(src, "aiball.db"));
    if (bad.length > 0) errors.push(`the database fails integrity_check: ${bad.slice(0, 3).join("; ")}`);

    const m = manifest.schema?.migration_created_at ?? null;
    if (m !== null && !knownMigrations.includes(m)) {
        const newest = knownMigrations.length ? Math.max(...knownMigrations) : 0;
        errors.push(m > newest
            ? "the backup's schema is newer than this install — upgrade aiball, then restore"
            : "the backup's last migration is unknown to this install");
    }
    return { manifest, errors };
}

/** The `when` of every migration in a drizzle journal. */
export function readKnownMigrations(migrationsFolder: string): number[] {
    const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
        entries: Array<{ when: number }>;
    };
    return journal.entries.map((e) => e.when);
}

export interface RestoreResult {
    setAside: { home: string | null; config: string | null };
}

/**
 * Put a VERIFIED backup in place. The caller has checked the daemon is down and
 * that `verifyBackup` returned no error. The current home and config directory
 * are renamed aside (`<dir>.pre-restore-<stamp>`), never deleted.
 */
export function applyRestore(input: BackupPaths & { src: string; manifest: BackupManifest; now?: Date }): RestoreResult {
    const { home, configDir, src, manifest } = input;
    const stamp = (input.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const aside = (dir: string): string | null => {
        if (!existsSync(dir)) return null;
        const target = `${dir}.pre-restore-${stamp}`;
        renameSync(dir, target);
        return target;
    };
    const setAside = { home: aside(home), config: aside(configDir) };
    mkdirSync(home, { recursive: true, mode: 0o700 });
    for (const rel of Object.keys(manifest.files)) {
        const from = join(src, ...rel.split("/"));
        const parts = rel.split("/");
        const to = rel === "aiball.db"
            ? join(home, "aiball.db")
            : parts[0] === "home"
                ? join(home, ...parts.slice(1))
                : join(configDir, ...parts.slice(1));
        copyPrivate(from, to);
    }
    return { setAside };
}
