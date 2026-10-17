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
 * --range           each cell as low–median–high instead of the median
 * --counterfactual  also the same table for Claude sessions alone: each loop
 *                   wake typed by hand, each cross-project comment carried by hand
 * --json            everything, as JSON
 *
 * A day's `src` column says what it rests on: b = board, c = Claude
 * transcripts, l = loop logs (keys at the terminal; a few days at most). The
 * fewer the letters, the less the estimate rests on.
 */
import { PARAM_SETS, estimate, dayOf, type Act, type Spend, type Weight } from "../src/devtools/attention-model.js";
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

function runs(acts: Act[], weight: Weight, spend: Spend[]): Record<"low" | "median" | "high", Table> {
    return {
        low: estimate(acts, PARAM_SETS.low, { weight, spend }),
        median: estimate(acts, PARAM_SETS.median, { weight, spend }),
        high: estimate(acts, PARAM_SETS.high, { weight, spend }),
    };
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
const acts = src.acts.filter(keep);
const cf = src.counterfactual.filter(keep);
const weight = (arg("weight") ?? "acts") as Weight;
if (weight !== "acts" && weight !== "tokens") throw new Error(`--weight: acts or tokens, not ${weight}`);
const spend = src.spend.filter((x) => !only || only.includes(x.project));
const real = runs(acts, weight, spend);
const counter = flag("counterfactual") || flag("json") ? runs(cf, weight, spend) : null;

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
    }, null, 2));
} else {
    console.log(render("Human working time", real, projects, days, src.coverage, flag("range")));
    if (counter) {
        console.log("");
        console.log(render("Claude sessions alone, same work", counter, projects, days, src.coverage, flag("range")));
    }
    console.log(`\n${acts.length} human acts read since ${dayOf(since)}, periods shared by ${weight}; src: b board, c Claude transcripts, l loop logs.`);
}
