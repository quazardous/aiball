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
import { eq as eqK } from "drizzle-orm";

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
const { getDb, nowIso } = await import("../src/db/connection.js");
const schema = await import("../src/schema.js");
const { computeHotFocus, compareWorkOrder } = await import("../src/db/work-order.js");
type WorkOrderCtx = Parameters<typeof compareWorkOrder>[2];
const { ticketSelfLastActivity } = await import("../src/db/tickets.js");
const { hotWindowSec } = await import("../src/api/inbox-row.js");
const { clearFlagsCache } = await import("../src/db/flags-cache.js");
// #2165 — l'invalidation RÉELLE, celle que le daemon appelle. Le simulateur
// ne modélise plus la réparation : il la juge.
const { invalidateFlagsCache } = await import("../src/db/projects.js");

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

/**
 * #2164 david — « une couche d'invalidation du cache centralisé qui invalide
 * dès qu'un ticket candidat est update », éprouvée AVANT d'être écrite.
 *
 * L'idée : au lieu de vider l'ensemble actionable de tout le monde à chaque
 * écriture, RÉPARER l'entrée du ticket touché — la porte scopée livrée en #2102
 * (`computeActionableTicketIds(c, [ids])`) est exactement la primitive qu'il
 * faut, et elle coûte 4-6 ms pour un ticket contre ~400 ms pour le board.
 *
 * Ce que ce test cherche n'est pas la vitesse, c'est la DIVERGENCE : après une
 * vraie écriture dans l'instantané, l'ensemble réparé est-il encore égal à
 * l'ensemble recalculé de zéro ? Le cas qui doit faire échouer une réparation
 * naïve est le bloqueur : fermer T libère ses dépendants, donc réparer T seul
 * laisse d'autres tickets faussement gatés — et un ticket faussement gaté
 * disparaît d'une file sans bruit.
 */
function cacheInvalidationTrial(samples: number, unwired = false): void {
    const db = getDb();
    console.log(`\n  invalidation ${unwired ? "DÉBRANCHÉE (témoin négatif)" : "réelle (#2165)"} — ${samples > 0 ? `${samples} écritures` : "tout le corpus"}`);
    // Échantillon DIRIGÉ vers le cas difficile. Tirer des tickets au hasard
    // teste surtout des fils isolés, où toute réparation passe : le cas qui
    // casse est le BLOQUEUR, dont la fermeture libère ses dépendants. On met
    // donc en tête les tickets portant une relation `depends_on`/`blocks`.
    const openSet = computeActionableTicketIds(CONSUMER).openIds;
    const related = new Set<number>();
    for (const r of db.select({ src: schema.messages.ticketId, tgt: schema.messages.sourceTicketId, meta: schema.messages.meta })
        .from(schema.messages).where(eqK(schema.messages.kind, "ticket_relation")).all() as { src: number; tgt: number | null; meta: string | null }[]) {
        if (!r.meta || !/depends_on|"blocks"/.test(r.meta)) continue;
        if (openSet.has(r.src)) related.add(r.src);
        if (r.tgt && openSet.has(r.tgt)) related.add(r.tgt);
    }
    const rest = [...openSet].filter((id) => !related.has(id));
    // david : « prend toute la base actuelle comme lot de travail ». `samples`
    // n'est plus un échantillon mais un plafond optionnel — par défaut on passe
    // sur TOUS les tickets ouverts. Les porteurs de relation restent en tête
    // pour que les divergences, s'il y en a, sortent tôt.
    const ordered = [...related, ...rest];
    const open = samples > 0 ? ordered.slice(0, samples) : ordered;
    console.log(`  ${open.length} tickets ouverts, dont ${related.size} portant une relation bloquante`);

    let ok = 0;
    const diverged: string[] = [];
    let seq = unwired ? 500_000 : 0;
    let repairMs = 0;
    let rebuildMs = 0;

    const asSet = () => new Set(computeActionableTicketIds(CONSUMER).actionableIds);

    let n = 0;
    for (const tid of open) {
        if (++n % 100 === 0) process.stdout.write(`\r  … ${n}/${open.length}`);
        // Le cache est CHAUD au moment de l'écriture, comme sur le daemon.
        clearFlagsCache();
        computeActionableTicketIds(CONSUMER);

        // Une VRAIE écriture, dans l'instantané : c'est tout l'intérêt d'en avoir un.
        db.insert(schema.messages).values({
            id: 7_000_000 + ++seq, ticketId: tid, kind: "ticket_closed",
            status: "approved", byAgent: "sim", displaySeq: 900_000 + seq, createdAt: nowIso(),
        }).run();

        // Le témoin n'appelle rien — si le corpus le déclare exact, la
        // comparaison ne discrimine rien et le score d'à côté ne vaut rien.
        const t0 = performance.now();
        if (!unwired) invalidateFlagsCache([tid]);
        repairMs += performance.now() - t0;
        const patched = asSet();          // lecture du cache réparé

        const t1 = performance.now();
        clearFlagsCache();
        const fresh = asSet();            // ce qu'un recalcul complet dirait
        rebuildMs += performance.now() - t1;

        const missing = [...fresh].filter((id) => !patched.has(id));
        const extra = [...patched].filter((id) => !fresh.has(id));
        if (missing.length === 0 && extra.length === 0) ok++;
        else diverged.push(`#${tid}: ${missing.length} manquants, ${extra.length} en trop`);
    }
    process.stdout.write("\r");
    console.log(`  ${ok}/${open.length} caches exacts après écriture`);
    for (const d of diverged.slice(0, 5)) console.log(`    divergence ${d}`);
    if (diverged.length > 5) console.log(`    … et ${diverged.length - 5} autres`);
    console.log(`  coût moyen : réparation ${(repairMs / open.length).toFixed(1)} ms/écriture`
        + ` contre ${(rebuildMs / open.length).toFixed(1)} ms pour le recalcul qu'elle évite`);
}

console.log(`\nsimulateur d'ordre de travail — consommateur ${CONSUMER}, page de ${LIMIT}`);
console.log(`instantané : ${snapHome}\n`);
const ref = run("référence (actuel)", reference, null);
run("fenêtre hot (#2164)", hotWindow, ref);
clockHorizon();
// Un essai FERME des tickets dans l'instantané, donc deux essais dans le même
// processus ne partent pas du même état — le second tirerait un autre
// échantillon et ne comparerait plus rien. Chaque essai veut son propre
// instantané : `--cache` pour l'invalidation réelle, `--cache --unwired` pour
// le témoin négatif.
if (argv.includes("--cache")) {
    cacheInvalidationTrial(Number(argOf("samples", "0")), argv.includes("--unwired"));
}

if (!KEEP) rmSync(snapHome, { recursive: true, force: true });
else console.log(`\ninstantané conservé : ${snapHome}`);
