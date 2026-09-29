/**
 * #3380 — the unit test files the critical profile runs: the backward-compatibility
 * list (`tests/critical-bc.txt`), the test files that changed, and the test files
 * that import a source module that changed. Changed = against `AIBALL_TEST_BASE`
 * (default `origin/main`), in the checkout under test. One path per line.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";

const root = process.argv[2] ?? process.cwd();
const base = process.env.AIBALL_TEST_BASE ?? "origin/main";

function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
        if (e === "node_modules") continue;
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (e.endsWith(".test.ts")) out.push(relative(root, p));
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
const changedModules = changed.filter((f) => !f.endsWith(".test.ts")).map((f) => basename(f, ".ts"));
const importRe = changedModules.length
    ? new RegExp(`from ["'][^"']*/(${changedModules.map((m) => m.replace(/[.+^${}()|[\]\\-]/g, "\\$&")).join("|")})\\.js["']`)
    : null;

const picked = tests.filter((t) =>
    listed.some((re) => re.test(t))
    || changed.includes(t)
    || (importRe !== null && importRe.test(readFileSync(join(root, t), "utf8"))));
for (const t of picked) console.log(t);
