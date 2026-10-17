/**
 * The human's working hours, per project and per day, estimated from the
 * traces aiball and Claude Code already keep (#4088). A report: it reads, it
 * writes nothing. How it estimates: src/devtools/attention-model.ts. What it
 * reads: src/devtools/attention-sources.ts.
 *
 *     npx tsx scripts/attention-report.ts [--since 30d] [--project helios[,mcu]]
 *                                         [--range] [--counterfactual] [--json]
 *
 * --since           how far back: Nd (days) or a date (default 30d)
 * --project         only these projects (comma-separated)
 * --weight          how a period is shared among its projects: acts (the
 *                   human's acts on each, default) or tokens (what each
 *                   project's Claude sessions spent in it)
 * --no-agent-tickets  leave out the tickets agents filed (by default, one
 *                   counts as the human's trace when a human act is within 30 min)
 * --range           each cell as low–median–high instead of the median
 * --counterfactual  also the same table for Claude sessions alone: each loop
 *                   wake typed by hand, each cross-project comment carried by hand
 * --json            everything, as JSON
 *
 * Past Claude's transcripts (30 days by default) the estimate is degraded: on
 * the days the transcripts cover, a factor per project is learned between the
 * full estimate and the one from the board and the UI log alone, and the older
 * days get that estimate times the factor (src `~`).
 *
 * A day's `src` column says what it rests on: b = board, c = Claude
 * transcripts, l = loop logs (keys at the terminal; a few days at most),
 * u = UI actions (reading in the web board, tvty, the CLI). The
 * fewer the letters, the less the estimate rests on.
 */
import { DURABLE_KINDS, PARAM_SETS, calibrate, dayOf, estimate, extrapolate, supervisedOnly, type Act, type Calibration, type Spend, type Weight } from "../src/devtools/attention-model.js";
import { collect, defaultOptions } from "../src/devtools/attention-sources.js";

type Table = Map<string, Map<string, number>>;

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function sinceMs(spec: string): number {
    const days = /^(\d+)d$/.exec(spec);
    if (days) {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d.getTime() - (Number(days[1]) - 1) * 86_400_000;
    }
    const t = Date.parse(spec);
    if (!Number.isFinite(t)) throw new Error(`--since: ${spec} is neither Nd nor a date`);
    return t;
}

type Level = "low" | "median" | "high";
const LEVELS: Level[] = ["low", "median", "high"];

/**
 * #4091 — one run per level. Past Claude's transcripts (30 days by default)
 * only the durable sources remain (the board, the UI log), which see less of the
 * work: on the training days, where every source exists, a factor per project
 * is learned (full / durable), and the older days get durable × factor.
 */
function runs(acts: Act[], weight: Weight, spend: Spend[], train: string[], degraded: string[]): { hours: Record<Level, Table>; calibration: Record<Level, Calibration> | null } {
    const durableActs = acts.filter((a) => DURABLE_KINDS.has(a.kind));
    const hours = {} as Record<Level, Table>;
    const calibration = {} as Record<Level, Calibration>;
    for (const level of LEVELS) {
        const full = estimate(acts, PARAM_SETS[level], { weight, spend });
        if (!degraded.length || !train.length) { hours[level] = full; continue; }
        const durable = estimate(durableActs, PARAM_SETS[level], { weight, spend });
        const cal = calibrate(full, durable, train);
        const old = extrapolate(durable, cal, degraded);
        for (const d of degraded) full.delete(d);
        for (const [d, row] of old) full.set(d, row);
        hours[level] = full;
        calibration[level] = cal;
    }
    return { hours, calibration: degraded.length && train.length ? calibration : null };
}

const h = (n: number | undefined) => (n ?? 0).toFixed(1);

function render(title: string, r: Record<"low" | "median" | "high", Table>, projects: string[], days: string[], coverage: Map<string, Set<string>>, range: boolean): string {
    const cell = (day: string, p?: string) => {
        const get = (t: Table) => p ? t.get(day)?.get(p) ?? 0 : [...(t.get(day)?.values() ?? [])].reduce((a, b) => a + b, 0);
        return range ? `${h(get(r.low))}–${h(get(r.median))}–${h(get(r.high))}` : h(get(r.median));
    };
    const head = ["day", ...projects, "total", "src"];
    const lines = days.map((d) => [d, ...projects.map((p) => cell(d, p)), cell(d), [...(coverage.get(d) ?? [])].sort().join("")]);
    const totals = ["total", ...projects.map((p) => {
        const sum = (t: Table) => days.reduce((a, d) => a + (t.get(d)?.get(p) ?? 0), 0);
        return range ? `${h(sum(r.low))}–${h(sum(r.median))}–${h(sum(r.high))}` : h(sum(r.median));
    })];
    const all = (t: Table) => days.reduce((a, d) => a + [...(t.get(d)?.values() ?? [])].reduce((x, y) => x + y, 0), 0);
    totals.push(range ? `${h(all(r.low))}–${h(all(r.median))}–${h(all(r.high))}` : h(all(r.median)), "");
    const rowsOut = [head, ...lines, totals];
    const widths = head.map((_, i) => Math.max(...rowsOut.map((row) => row[i].length)));
    const fmt = (row: string[]) => row.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
    return [`${title} (hours${range ? ", low–median–high" : ", median"})`, fmt(head), ...lines.map(fmt), fmt(totals)].join("\n");
}

const since = sinceMs(arg("since") ?? "30d");
const only = arg("project")?.split(",").map((s) => s.trim()).filter(Boolean);
const keep = (a: Act) => !only || only.includes(a.project);
const src = await collect(defaultOptions(since, (ms) => dayOf(ms)));
// A ticket an agent filed counts as the human's trace when one of the human's
// acts is within 30 minutes (--no-agent-tickets: never).
const filed = flag("no-agent-tickets") ? [] : supervisedOnly(src.agentTickets, src.acts);
const acts = [...src.acts, ...filed].filter(keep);
const cf = [...src.counterfactual, ...filed].filter(keep);
const weight = (arg("weight") ?? "acts") as Weight;
if (weight !== "acts" && weight !== "tokens") throw new Error(`--weight: acts or tokens, not ${weight}`);
const spend = src.spend.filter((x) => !only || only.includes(x.project));
// The training days: those the transcripts cover. The days before the first of
// them are past Claude's retention, and extrapolated.
const train = [...src.coverage].filter(([, s]) => s.has("c")).map(([d]) => d).sort();
const allDays = [...src.coverage.keys()].filter((d) => d >= dayOf(since)).sort();
const degraded = train.length ? allDays.filter((d) => d < train[0]) : [];
for (const d of degraded) src.coverage.get(d)?.add("~" as never);
const realRun = runs(acts, weight, spend, train, degraded);
const real = realRun.hours;
const counterRun = flag("counterfactual") || flag("json") ? runs(cf, weight, spend, train, degraded) : null;
const counter = counterRun?.hours ?? null;

const projectTotal = new Map<string, number>();
for (const row of real.median.values()) for (const [p, v] of row) projectTotal.set(p, (projectTotal.get(p) ?? 0) + v);
const projects = [...projectTotal].filter(([, v]) => v >= 0.05).sort((a, b) => b[1] - a[1]).map(([p]) => p);
const days = [...new Set([...real.median.keys(), ...(counter?.median.keys() ?? [])])].filter((d) => d >= dayOf(since)).sort();

if (flag("json")) {
    const obj = (t: Table) => Object.fromEntries([...t].map(([d, row]) => [d, Object.fromEntries(row)]));
    console.log(JSON.stringify({
        since: new Date(since).toISOString(),
        params: PARAM_SETS,
        weight,
        acts: acts.length,
        coverage: Object.fromEntries([...src.coverage].map(([d, s]) => [d, [...s].sort().join("")])),
        hours: { low: obj(real.low), median: obj(real.median), high: obj(real.high) },
        claude_only: counter && { low: obj(counter.low), median: obj(counter.median), high: obj(counter.high) },
        extrapolated: degraded.length ? {
            days: degraded,
            training: train,
            factors: realRun.calibration && Object.fromEntries(LEVELS.map((l) => [l, { global: realRun.calibration![l].global, per_project: Object.fromEntries(realRun.calibration![l].perProject) }])),
        } : null,
    }, null, 2));
} else {
    console.log(render("Human working time", real, projects, days, src.coverage, flag("range")));
    if (counter) {
        console.log("");
        console.log(render("Claude sessions alone, same work", counter, projects, days, src.coverage, flag("range")));
    }
    console.log(`\n${acts.length} human acts read since ${dayOf(since)}, periods shared by ${weight}; src: b board, c Claude transcripts, l loop logs, u UI actions, ~ extrapolated.`);
    if (degraded.length && realRun.calibration) {
        const cal = realRun.calibration.median;
        const top = projects.filter((p) => cal.perProject.has(p)).slice(0, 8).map((p) => `${p} ×${cal.perProject.get(p)!.toFixed(2)}`).join(", ");
        console.log(`Before ${train[0]} (past Claude's transcripts) the days are extrapolated from the board and the UI log: factors learned on ${train[0]}…${train[train.length - 1]}, median run — ${top}; others ×${cal.global.toFixed(2)}.`);
    }
}
