/**
 * #2165 — work-order simulator.
 *
 * `ticket_list` is a RANKING query, not a listing one: to return the top N of a
 * consumer's work order it has to situate every ticket of the board, because
 * the sort key — open, unread, actionable, priority, hot — is derived per
 * consumer at read time and stored nowhere.
 *
 * Any attempt to make that cheaper has one failure mode that matters: a variant
 * that is faster and reorders the head of somebody's queue does not crash, it
 * quietly hands them the wrong work. So this tool asks two questions of every
 * variant, in this order:
 *
 *     1. does it produce the SAME order as the reference?
 *     2. how long does it take?
 *
 * The second only counts once the first is yes.
 *
 * It runs against a FROZEN SNAPSHOT of the real database, taken with SQLite's
 * own backup so a concurrent daemon write cannot tear it. Two runs therefore
 * compare variants on identical data, and nothing here can touch the live
 * board — every query is a read, and it is not even the same file.
 *
 *     npx tsx scripts/sim-work-order.ts [--consumer <id>] [--limit <n>] [--keep]
 *
 * FIDELITY, stated so nobody reads more into a run than it says: the reference
 * here reproduces the route's tier / priority / hot keys, but not its
 * own-claim and assigned-to-me tiebreaks, which need sets the route builds from
 * request context. Variants are therefore comparable to EACH OTHER on identical
 * data — which is what this tool is for — while an absolute millisecond figure
 * belongs to a measurement against the daemon, not to this file.
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const CONSUMER = argOf("consumer", "claude-aiball-dev");
const LIMIT = Number(argOf("limit", "30"));
const KEEP = argv.includes("--keep");

const liveHome = process.env.AIBALL_HOME ?? join(process.env.HOME ?? "", ".local/share/aiball");
const liveDb = join(liveHome, "aiball.db");
if (!existsSync(liveDb)) {
    console.error(`no database at ${liveDb} — set AIBALL_HOME to the board you want to simulate`);
    process.exit(1);
}

const snapHome = mkdtempSync(join(tmpdir(), "aiball-sim-"));
{
    // `.backup()` is SQLite's own consistent copy: safe against a daemon
    // writing underneath, unlike `cp` on a live WAL database.
    const src = new Database(liveDb, { readonly: true });
    await src.backup(join(snapHome, "aiball.db"));
    src.close();
}
process.env.AIBALL_HOME = snapHome;
// The socket is inherited from the session and would send the client at the
// LIVE daemon; this tool must only ever read its own snapshot.
process.env.AIBALL_SOCK = "";

const { listMessages, ticketUnreadFlags } = await import("../src/db.js");
const { computeActionableTicketIds } = await import("../src/db/projects.js");
const { computeHotFocus, compareWorkOrder } = await import("../src/db/work-order.js");
type WorkOrderCtx = Parameters<typeof compareWorkOrder>[2];
const { ticketSelfLastActivity } = await import("../src/db/tickets.js");
const { hotWindowSec } = await import("../src/api/inbox-row.js");
const { invalidateFlagsCache } = await import("../src/db/flags-cache.js");

const PRIORITY_WEIGHT: Record<string, number> = { urgent: 4, high: 3, normal: 2, low: 1 };
const hotWinMs = hotWindowSec() * 1000;

type Row = { id: number; priority: string | null; postponed_until?: string | null };

/** Everything a ranking needs that is NOT the hot tiebreak. */
function commonInputs() {
    const created = listMessages({ kind: "ticket_created" }) as unknown as Row[];
    const ids = created.map((m) => m.id);
    const unread = ticketUnreadFlags(CONSUMER, ids);
    const { openIds, actionableIds } = computeActionableTicketIds(CONSUMER);
    const tierOf = (id: number) =>
        unread.get(id) ? 0 : actionableIds.has(id) ? 1 : openIds.has(id) ? 2 : 3;
    return { created, ids, tierOf };
}

function ctxWith(tierOf: (id: number) => number, hot: Set<number>): WorkOrderCtx {
    return {
        tierOf,
        priorityWeight: (p) => PRIORITY_WEIGHT[p ?? "normal"] ?? 2,
        isHot: (id) => hot.has(id),
        isOwnClaim: () => false,
        isAssignedToMe: () => false,
    };
}

/** What the route does today: hot for every ticket, then sort, then cut. */
function reference(): number[] {
    const { created, ids, tierOf } = commonInputs();
    const hot = computeHotFocus(ticketSelfLastActivity(CONSUMER, ids), Date.now(), hotWinMs);
    const ctx = ctxWith(tierOf, hot);
    return [...created].sort((a, b) => compareWorkOrder(a, b, ctx)).slice(0, LIMIT).map((m) => m.id);
}

/**
 * #2164's pending plan: hot only breaks ties between equal (tier, priority), so
 * compute it for the CONTENDER WINDOW — everything whose key is <= the Nth's —
 * instead of the whole board.
 */
function hotWindow(): number[] {
    const { created, tierOf } = commonInputs();
    const keyOf = (m: Row) => tierOf(m.id) * 10 + (9 - (PRIORITY_WEIGHT[m.priority ?? "normal"] ?? 2));
    const coarse = [...created].sort((a, b) => keyOf(a) - keyOf(b) || a.id - b.id);
    const cut = keyOf(coarse[Math.min(LIMIT, coarse.length) - 1]);
    // Strictly-above rows are in the page too and can tie among THEMSELVES, so
    // the window is `key <= cut`, not just the rows sitting on the threshold.
    const window = coarse.filter((m) => keyOf(m) <= cut);
    const hot = computeHotFocus(
        ticketSelfLastActivity(CONSUMER, window.map((m) => m.id)),
        Date.now(),
        hotWinMs,
    );
    const ctx = ctxWith(tierOf, hot);
    return [...window].sort((a, b) => compareWorkOrder(a, b, ctx)).slice(0, LIMIT).map((m) => m.id);
}

function run(label: string, fn: () => number[], ref: number[] | null) {
    invalidateFlagsCache();
    const t0 = performance.now();
    const out = fn();
    const ms = performance.now() - t0;
    const same = ref === null ? "(référence)" : out.join(",") === ref.join(",") ? "ordre IDENTIQUE" : "*** ORDRE DIFFÉRENT ***";
    console.log(`  ${label.padEnd(26)} ${ms.toFixed(0).padStart(5)} ms   ${same}`);
    return out;
}

/**
 * How long a cached ranking COULD stay valid: the answer only changes on a
 * write, or when the clock crosses a snooze reveal or a claim expiry. Those two
 * instants are in the data, so a cache could expire when they say to instead of
 * guessing five seconds.
 */
function clockHorizon(): void {
    const db = new Database(join(snapHome, "aiball.db"), { readonly: true });
    const now = new Date().toISOString();
    const nextReveal = db.prepare(
        "select min(postponed_until) as t from tickets where postponed_until > ?",
    ).get(now) as { t: string | null };
    const lastWrite = db.prepare("select max(created_at) as t from _messages").get() as { t: string | null };
    db.close();
    console.log(`\n  prochaine bascule d'horloge (révélation de snooze) : ${nextReveal.t ?? "aucune"}`);
    console.log(`  dernière écriture du board                        : ${lastWrite.t ?? "—"}`);
    console.log(`  TTL du cache aujourd'hui                          : 5 s`);
}

console.log(`\nsimulateur d'ordre de travail — consommateur ${CONSUMER}, page de ${LIMIT}`);
console.log(`instantané : ${snapHome}\n`);
const ref = run("référence (actuel)", reference, null);
run("fenêtre hot (#2164)", hotWindow, ref);
clockHorizon();

if (!KEEP) rmSync(snapHome, { recursive: true, force: true });
else console.log(`\ninstantané conservé : ${snapHome}`);
