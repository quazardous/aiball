/**
 * #3380 — the unit test files the critical profile runs: the backward-compatibility
 * list (`tests/critical-bc.txt`), the test files that changed, and the test files
 * that import a source module that changed — by name or through a module that
 * re-exports it, statically or with `import()` — and the test files named after
 * a module that changed. Changed = against `AIBALL_TEST_BASE`
 * (default `origin/main`), in the checkout under test. One path per line.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

const root = process.argv[2] ?? process.cwd();
const base = process.env.AIBALL_TEST_BASE ?? "origin/main";

function walk(dir: string, out: string[] = [], keep: (name: string) => boolean = (e) => e.endsWith(".test.ts")): string[] {
    for (const e of readdirSync(dir)) {
        if (e === "node_modules") continue;
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p, out, keep);
        else if (keep(e)) out.push(relative(root, p));
    }
    return out;
}
const tests = walk(join(root, "src"));

const globToRe = (g: string) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
const listed = readFileSync(join(root, "tests/critical-bc.txt"), "utf8").split("\n")
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(globToRe);

let changed: string[] = [];
try {
    const mb = execFileSync("git", ["-C", root, "merge-base", "HEAD", base], { encoding: "utf8" }).trim();
    changed = execFileSync("git", ["-C", root, "diff", "--name-only", mb], { encoding: "utf8" })
        .split("\n").filter((f) => f.startsWith("src/") && f.endsWith(".ts"));
} catch {
    // No base to compare with: the whole suite, rather than a guess.
    for (const t of tests) console.log(t);
    process.exit(0);
}
// A changed module, and every module that re-exports it (`export … from`), to
// any depth: a test reaching `db/projects.ts` through the `db.ts` barrel tests
// it as much as one importing it by name.
const SPEC = String.raw`["']([^"']+)\.js["']`;
const importsOf = (file: string, re: RegExp): string[] => {
    const out: string[] = [];
    const text = readFileSync(join(root, file), "utf8");
    for (const m of text.matchAll(re)) {
        if (!m[1]!.startsWith(".")) continue;
        out.push(relative(root, join(root, dirname(file), m[1]! + ".ts")));
    }
    return out;
};
const REEXPORT = new RegExp(String.raw`export\s+(?:\*|\{[^}]*\})\s+from\s+` + SPEC, "g");
// Static and dynamic imports alike: a test that sets its environment first
// loads its modules with `await import(…)`.
const IMPORT = new RegExp(String.raw`(?:from\s+|import\(\s*)` + SPEC, "g");

const changedNames = changed.filter((f) => !f.endsWith(".test.ts")).map((f) => basename(f, ".ts")).filter((n) => n.length >= 5);
const sources = walk(join(root, "src"), [], (e) => e.endsWith(".ts") && !e.endsWith(".test.ts"));
const reexportedBy = new Map<string, string[]>();
for (const f of sources) {
    for (const target of importsOf(f, REEXPORT)) reexportedBy.set(target, [...(reexportedBy.get(target) ?? []), f]);
}
const touched = new Set(changed.filter((f) => !f.endsWith(".test.ts")));
for (const f of touched) for (const by of reexportedBy.get(f) ?? []) touched.add(by);

const picked = tests.filter((t) =>
    listed.some((re) => re.test(t))
    || changed.includes(t)
    || (touched.size > 0 && importsOf(t, IMPORT).some((f) => touched.has(f)))
    // A module's tests are named after it, wherever they reach it from: those of
    // `db/critical-ticket.ts` go through the bus (`api/critical-ticket.test.ts`)
    // and import no file that changed.
    || changedNames.some((n) => basename(t).includes(n)));
for (const t of picked) console.log(t);
