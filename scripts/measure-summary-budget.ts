/**
 * #2214 — did the summary budget (#2203) do what it was for?
 *
 * Three numbers, measured against the baseline taken before the budget landed
 * (last month of agent summaries: median 871 characters, 82% over 500, 4.4%
 * opening on what the author just did):
 *
 *   1. refusals per day and per agent — from the daemon journal, the only place
 *      a refusal is recorded (nothing is posted, so nothing reaches the DB);
 *   2. length of the agent summaries accepted since `--since`;
 *   3. share of those opening on the author's own gesture ("Livré…", "I shipped…",
 *      "Plan:") — the drift that got the May cap removed. Same detector as the
 *      #2203 measurement, so the numbers compare.
 *
 * Read-only. Usage:
 *   npx tsx scripts/measure-summary-budget.ts --since "2026-09-10 16:20"
 * `--since` is local time, as journalctl reads it.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
};
const since = arg("--since");
if (!since) {
    console.error('usage: measure-summary-budget.ts --since "YYYY-MM-DD HH:MM" (local time)');
    process.exit(2);
}

// 1 — refusals, from the journal.
let journal = "";
try {
    journal = execFileSync("journalctl", ["--user", "-u", "aiball", "--since", since, "--no-pager", "-o", "short-iso"], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
    });
} catch (e) {
    console.error(`journalctl failed: ${(e as Error).message}`);
}
const TRACE = /^(\d{4}-\d{2}-\d{2})T\S+ .*\[summary-budget\] refused agent=(\S+) project=(\S+) length=(\d+) budget=(\d+)/;
const perDay = new Map<string, number>();
const perAgent = new Map<string, number>();
let refusals = 0;
for (const line of journal.split("\n")) {
    const m = TRACE.exec(line);
    if (!m) continue;
    refusals++;
    perDay.set(m[1], (perDay.get(m[1]) ?? 0) + 1);
    perAgent.set(m[2], (perAgent.get(m[2]) ?? 0) + 1);
}
console.log(`refusals since ${since}: ${refusals}`);
for (const [day, n] of [...perDay].sort()) console.log(`  ${day}  ${n}`);
for (const [agent, n] of [...perAgent].sort((a, b) => b[1] - a[1])) console.log(`  ${agent.padEnd(28)} ${n}`);

// 2 + 3 — accepted agent summaries, from the database (read-only).
const home = process.env.AIBALL_HOME ?? join(homedir(), ".local", "share", "aiball");
const db = new DatabaseSync(join(home, "aiball.db"), { readOnly: true });
const sinceIso = new Date(since.replace(" ", "T")).toISOString();
const rows = db.prepare(`
    SELECT json_extract(m.meta, '$.summary_until') AS su, m.by_agent AS agent
    FROM _messages m LEFT JOIN consumers c ON c.consumer_id = m.by_agent
    WHERE m.kind = 'comment_added' AND m.created_at >= ?
      AND json_extract(m.meta, '$.summary_until') IS NOT NULL
      AND COALESCE(c.kind, 'agent') <> 'human'
`).all(sinceIso) as Array<{ su: string; agent: string | null }>;
const lengths = rows.map((r) => String(r.su).length).sort((a, b) => a - b);
const pct = (p: number) => lengths[Math.floor(lengths.length * p)] ?? 0;
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const DELTA = /^(\*\*)?(shipped|added|fixed|implemented|posted|created|filed|landed|merged|committed|refactored|moved|removed|updated|wrote|done:|i |i've |livre|ajoute|corrige|implemente|poste|cree|depose|commite|refactore|deplace|retire|j'ai |plan ?:)/;
const isDelta = (su: string) => DELTA.test(fold(su));
const delta = rows.filter((r) => isDelta(String(r.su))).length;
console.log(`accepted agent summaries since ${since}: ${lengths.length}`);
if (lengths.length > 0) {
    console.log(`  length  median ${pct(0.5)} · p90 ${pct(0.9)} · max ${lengths[lengths.length - 1]}   (baseline median 871)`);
    console.log(`  opening on the author's gesture: ${delta} (${((100 * delta) / lengths.length).toFixed(1)}%)   (baseline 4.4%)`);
}

// 4 — #2320: the same drift, per agent. The alert is per agent because the plan
// answers a drift by telling the agent's project, not by tightening the rule.
// An agent is flagged above DRIFT_ALERT_PCT with at least MIN_SAMPLE summaries,
// and two of its flagged summaries are printed to rewrite as ticket state.
const DRIFT_ALERT_PCT = 6;
const MIN_SAMPLE = 10;
const byAgent = new Map<string, { total: number; delta: string[] }>();
for (const r of rows) {
    const agent = r.agent ?? "(unknown)";
    const entry = byAgent.get(agent) ?? { total: 0, delta: [] };
    entry.total++;
    if (isDelta(String(r.su))) entry.delta.push(String(r.su));
    byAgent.set(agent, entry);
}
if (byAgent.size > 0) {
    console.log(`  per agent (flag ≥ ${DRIFT_ALERT_PCT}% with ≥ ${MIN_SAMPLE} summaries):`);
    const ranked = [...byAgent].sort((a, b) => b[1].delta.length - a[1].delta.length || b[1].total - a[1].total);
    for (const [agent, { total, delta: hits }] of ranked) {
        const share = (100 * hits.length) / total;
        const flagged = total >= MIN_SAMPLE && share >= DRIFT_ALERT_PCT;
        console.log(`    ${flagged ? "!" : " "} ${agent.padEnd(28)} ${String(hits.length).padStart(3)} / ${String(total).padEnd(4)} ${share.toFixed(1)}%`);
        if (flagged) {
            for (const su of hits.slice(0, 2)) console.log(`        « ${su.replace(/\s+/g, " ").slice(0, 140)}${su.length > 140 ? "…" : ""} »`);
        }
    }
}
