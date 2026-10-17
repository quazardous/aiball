/**
 * #4090 — what a human does in a UI (the web board, tvty, the CLI), kept so the
 * attention report (#4088) sees reading, not only writing: viewing a ticket,
 * searching, typing into a session from the board leave no row anywhere else.
 *
 * One line per bus call a human makes, written where every call passes
 * (`runOne`). Identifiers only — the method, the project, the ticket — never a
 * body, a text or a secret.
 *
 * Compact on disk: one file per UTC day (`ui-actions/2026-10-17.tsv`), so a line
 * carries only its time; a past day is gzipped when the next one starts, and a
 * day older than `logs.ui_actions.retention` (180 days by default) is deleted.
 * A line:
 *
 *     09:14:25.655 <TAB> david <TAB> web <TAB> ticket.get <TAB> aiball <TAB> 4088
 *
 * Best effort: a failed write is dropped, never the call.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { AIBALL_HOME } from "./paths.js";
import { getConfig } from "./db/config-overrides.js";

export const UI_ACTIONS_DIR = join(AIBALL_HOME, "ui-actions");
export const UI_ACTIONS_RETENTION_KEY = "logs.ui_actions.retention";
const DEFAULT_RETENTION_SEC = 180 * 86_400;

const clean = (v: unknown): string => (v === undefined || v === null ? "" : String(v).replace(/[\t\r\n]/g, " ").slice(0, 120));

/** The project and the ticket a call names, from its parameters; nothing else is read. */
export function uiActionTarget(params: unknown): { project: string; ticket: string } {
    const p = (params ?? {}) as Record<string, unknown>;
    const ticket = [p.ticket_id, p.target_id, p.id].find((v) => typeof v === "number" && Number.isInteger(v));
    return { project: typeof p.project === "string" ? p.project : "", ticket: ticket === undefined ? "" : String(ticket) };
}

/** One line, without its date (the file carries the day). */
export function uiActionLine(atMs: number, consumer: string, client: string, method: string, params: unknown): string {
    const { project, ticket } = uiActionTarget(params);
    const time = new Date(atMs).toISOString().slice(11, 23);
    return [time, clean(consumer), clean(client), clean(method), clean(project), clean(ticket)].join("\t") + "\n";
}

function retentionSec(): number {
    const raw = Number(getConfig(UI_ACTIONS_RETENTION_KEY) ?? DEFAULT_RETENTION_SEC);
    return Number.isFinite(raw) ? raw : DEFAULT_RETENTION_SEC;
}

/** Gzip the past days, delete those past the retention. Run once per new day. */
export function housekeep(dir: string, todayUtc: string, retention: number, nowMs: number): void {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    const oldest = new Date(nowMs - retention * 1000).toISOString().slice(0, 10);
    for (const name of names) {
        const day = /^(\d{4}-\d{2}-\d{2})\.tsv(\.gz)?$/.exec(name);
        if (!day) continue;
        const path = join(dir, name);
        try {
            if (day[1] < oldest) { unlinkSync(path); continue; }
            if (!day[2] && day[1] < todayUtc) {
                writeFileSync(`${path}.gz`, gzipSync(readFileSync(path)));
                unlinkSync(path);
            }
        } catch { /* the next day tries again */ }
    }
}

let lastDay: string | null = null;

/** Record one call, when its caller is a human and the log is on. Never throws. */
export function recordUiAction(
    caller: { kind: string; consumer_id?: string; platform?: string | null; transport?: string },
    method: string,
    params: unknown,
    nowMs: number = Date.now(),
    dir: string = UI_ACTIONS_DIR,
): void {
    if (caller.kind !== "human") return;
    try {
        const retention = retentionSec();
        if (retention <= 0) return;
        const day = new Date(nowMs).toISOString().slice(0, 10);
        if (day !== lastDay) {
            mkdirSync(dir, { recursive: true });
            housekeep(dir, day, retention, nowMs);
            lastDay = day;
        }
        const client = caller.platform || caller.transport || "";
        appendFileSync(join(dir, `${day}.tsv`), uiActionLine(nowMs, caller.consumer_id ?? "", client, method, params));
    } catch { /* best effort: the call goes on */ }
}

/** Tests only: forget which day the log last saw. */
export function resetUiActionsDayForTests(): void {
    lastDay = null;
}
