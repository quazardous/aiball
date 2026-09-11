/**
 * The board simulator's live copy: what must go before the copy is served.
 *
 * `npm run sim -- up --from-live` loads a consistent copy of the live database
 * into the simulated board. The copy carries every credential the live board
 * holds, and the simulated board listens on a known moderator password, so the
 * copy is wiped of them first: every token (agents, humans' sessions, nodes,
 * signal keys, install), every password, the node wiring and pairing requests,
 * and every ticket payload (whose values are secret unless listed public).
 * Tickets, threads, relations, subscriptions and wake logs stay: they are what
 * the copy is for.
 *
 * `SECRET_WIPES` is the one list. A test holds every secret-looking column of
 * the schema to it, so a new one fails until it is wiped or classified here.
 */
import type Database from "better-sqlite3";

export interface SecretWipe {
    table: string;
    /** A whole table goes, or only some columns are cleared. */
    clear: "rows" | readonly string[];
    why: string;
}

export const SECRET_WIPES: readonly SecretWipe[] = [
    { table: "tokens", clear: "rows", why: "every bearer token: agents, human sessions, nodes, signal keys, install" },
    { table: "consumers", clear: ["password_hash"], why: "human logins; the moderator's is set again after the wipe" },
    { table: "node_project_config", clear: "rows", why: "keyed by node token" },
    { table: "node_enrollments", clear: "rows", why: "pairing codes and the node tokens minted for them" },
    { table: "ticket_payloads", clear: "rows", why: "payload values are secret unless listed public" },
];

/**
 * Columns whose name looks secret but whose content is not, with the reason.
 * A secret-looking column in neither list fails the guard test.
 */
export const NOT_SECRET_COLUMNS: Readonly<Record<string, string>> = {
    "ticket_token_usage.tokens_in": "a usage counter",
    "ticket_token_usage.tokens_out": "a usage counter",
    "project_token_usage.tokens_in": "a usage counter",
    "project_token_usage.tokens_out": "a usage counter",
    "token_usage_snapshot.tokens_in": "a usage counter",
    "token_usage_snapshot.tokens_out": "a usage counter",
    "signals.dedup_key": "a caller-chosen grouping label, not a credential",
    "settings.key": "the name of an internal counter or setting; its value is not a credential",
    "config_overrides.key": "the name of a configuration setting (tickets.*, autopoll.*), not a credential",
};

/** Does this column name look like it could hold a secret? */
export function looksSecret(column: string): boolean {
    return /token|password|passwd|secret|credential|payload|private|(^|_)key$/i.test(column);
}

/** Wipe the secrets out of a copy. Returns how many rows each wipe touched. */
export function sanitizeCopy(db: Database.Database): Record<string, number> {
    const touched: Record<string, number> = {};
    const run = db.transaction(() => {
        for (const w of SECRET_WIPES) {
            const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(w.table);
            if (!exists) continue;
            const sql = w.clear === "rows"
                ? `DELETE FROM "${w.table}"`
                : `UPDATE "${w.table}" SET ${w.clear.map((c) => `"${c}" = NULL`).join(", ")}`;
            touched[w.table] = db.prepare(sql).run().changes;
        }
    });
    run();
    return touched;
}
