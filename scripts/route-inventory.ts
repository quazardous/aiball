/**
 * The API's routes, and which consumer calls each one — measured on the code,
 * not estimated. Writes docs/API-ROUTES.md.
 *
 *     npx tsx scripts/route-inventory.ts [--tvty ../tvty] [--check]
 *
 * Routes: every `<router>.<verb>("<path>"` under src/api.ts, src/api/ and
 * src/app.ts (all routers are mounted at /api, except the few app-level paths).
 * Consumers:
 *   - loop / mcp / cli / sim: the methods of src/client.ts each calls, mapped to
 *     the paths those methods request;
 *   - web: every /api path in frontend/src;
 *   - tvty: every /api path in the tvty checkout's Rust sources, when found.
 * A call's `${…}` / `{}` segment matches any route parameter. A call whose verb
 * cannot be read matches every verb of its path. Calls that match no route are
 * listed at the end: they are dead or drifted.
 *
 * `--check` exits 1 when the generated file differs from the committed one.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const tvtyAt = args.indexOf("--tvty");
const TVTY = resolve(ROOT, tvtyAt >= 0 ? args[tvtyAt + 1]! : "../tvty");
const OUT = join(ROOT, "docs/API-ROUTES.md");

type Verb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";
interface Route { verb: Verb; path: string; file: string }
interface Call { verb: Verb; path: string }
const CONSUMERS = ["loop", "mcp", "cli", "sim", "web", "tvty"] as const;
type Consumer = typeof CONSUMERS[number];

function walk(dir: string, keep: (f: string) => boolean): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "target" || name === "dist" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walk(p, keep));
        else if (keep(p)) out.push(p);
    }
    return out;
}
const isSource = (f: string) => /\.(ts|vue)$/.test(f) && !/\.test\.ts$/.test(f);

// --- server routes ------------------------------------------------------------
const routes: Route[] = [];
for (const file of [join(ROOT, "src/api.ts"), join(ROOT, "src/app.ts"), ...walk(join(ROOT, "src/api"), isSource)]) {
    const text = readFileSync(file, "utf8");
    const appLevel = file.endsWith("src/app.ts");
    for (const m of text.matchAll(/\b[A-Za-z]+\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
        const path = m[2]!;
        if (!path.startsWith("/")) continue;
        routes.push({ verb: m[1]!.toUpperCase() as Verb, path: appLevel || path.startsWith("/api/") ? path : `/api${path}`, file: relative(ROOT, file) });
    }
}
const routeKey = (r: { verb: Verb; path: string }) => `${r.verb} ${r.path}`;
const uniqueRoutes = [...new Map(routes.map((r) => [routeKey(r), r])).values()]
    .sort((a, b) => a.path.localeCompare(b.path) || a.verb.localeCompare(b.verb));

// --- calls --------------------------------------------------------------------
/** Every `${…}` of a template literal, nested braces included, becomes `{}`. */
function flattenTemplates(text: string): string {
    let out = "";
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "$" && text[i + 1] === "{") {
            let depth = 1;
            let j = i + 2;
            for (; j < text.length && depth > 0; j++) {
                if (text[j] === "{") depth++;
                else if (text[j] === "}") depth--;
            }
            out += "{}";
            i = j - 1;
        } else {
            out += text[i];
        }
    }
    return out;
}

/** `/api/tickets/{}/assign?x=1` → `/api/tickets/{}/assign`; a `{}` glued to a
 *  segment's end is a query string built at run time, and is dropped. */
function normalizeCall(raw: string): string {
    return raw.split("?")[0]!
        .replace(/\{[^}/]*\}/g, "{}")
        .replace(/([^/])\{\}$/, "$1")
        .replace(/\/+$/, "") || "/";
}
/** The (verb, path) pairs a piece of source requests. */
/** Comments name paths without calling them: drop them (`//` only when it
 *  starts a line or follows a space, so `http://` in a string survives). */
function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function callsIn(source: string): Call[] {
    const text = flattenTemplates(stripComments(source));
    const calls: Call[] = [];
    const seen = new Set<string>();
    const add = (verb: Verb, raw: string) => {
        const path = normalizeCall(raw);
        const k = `${verb} ${path}`;
        if (!seen.has(k)) { seen.add(k); calls.push({ verb, path }); }
    };
    // A verb literal shortly before the path: ("GET", "/api/…") or method: "POST", url: `/api/…`.
    for (const m of text.matchAll(/["'`](GET|POST|PUT|PATCH|DELETE)["'`][^;\n]{0,120}?[`"'](\/api\/[^`"'\s)]+)/g)) {
        add(m[1] as Verb, m[2]!);
    }
    for (const m of text.matchAll(/[`"'](\/api\/[^`"'\s)]+)/g)) {
        const path = normalizeCall(m[1]!);
        if (![...seen].some((k) => k.endsWith(` ${path}`))) add("*", m[1]!);
    }
    return calls;
}

/** src/client.ts: method name → the calls in its body. */
function clientMethods(): Map<string, Call[]> {
    const text = readFileSync(join(ROOT, "src/client.ts"), "utf8");
    const lines = text.split("\n");
    const methods = new Map<string, Call[]>();
    let name: string | null = null;
    let body: string[] = [];
    const flush = () => { if (name) methods.set(name, [...(methods.get(name) ?? []), ...callsIn(body.join("\n"))]); };
    for (const line of lines) {
        const m = /^ {4}(?:async |private |public |static )*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:<[^>]*>)?\(/.exec(line);
        if (m && !/^ {4}(if|for|while|switch|return|catch)\b/.test(line)) {
            flush();
            name = m[1]!;
            body = [line];
        } else {
            body.push(line);
        }
    }
    flush();
    for (const [k, v] of methods) if (v.length === 0) methods.delete(k);
    return methods;
}

const methods = clientMethods();
const byConsumer = new Map<Consumer, Call[]>(CONSUMERS.map((c) => [c, []]));
const clientUsers: Array<[Consumer, string[]]> = [
    ["loop", walk(join(ROOT, "src/claude-loop"), isSource)],
    ["mcp", [join(ROOT, "src/mcp.ts"), ...walk(join(ROOT, "src/mcp"), isSource)]],
    ["cli", [join(ROOT, "src/cli.ts"), ...walk(join(ROOT, "src/cli"), isSource), ...walk(join(ROOT, "src/autopoll"), isSource)]],
    ["sim", [...walk(join(ROOT, "tests/sim"), isSource), ...walk(join(ROOT, "src/sim"), isSource)]],
];
for (const [consumer, files] of clientUsers) {
    const text = files.filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const [method, calls] of methods) {
        if (new RegExp(`\\.${method}\\(`).test(text)) byConsumer.get(consumer)!.push(...calls);
    }
    // Direct /api calls outside the client (the simulator talks HTTP itself).
    byConsumer.get(consumer)!.push(...callsIn(text));
}
byConsumer.get("web")!.push(...callsIn(walk(join(ROOT, "frontend/src"), isSource).map((f) => readFileSync(f, "utf8")).join("\n")));
const tvtyFiles = walk(join(TVTY, "src"), (f) => f.endsWith(".rs"));
byConsumer.get("tvty")!.push(...callsIn(tvtyFiles.map((f) => readFileSync(f, "utf8")).join("\n")));

// --- matching -----------------------------------------------------------------
function pathMatches(route: string, call: string): boolean {
    const r = route.split("/");
    const c = call.split("/");
    if (r.length !== c.length) return false;
    return r.every((seg, i) => seg === c[i] || seg.startsWith(":") || c[i] === "{}");
}
const users = new Map<string, Set<Consumer>>(uniqueRoutes.map((r) => [routeKey(r), new Set()]));
const unmatched = new Map<Consumer, Set<string>>(CONSUMERS.map((c) => [c, new Set()]));
for (const [consumer, calls] of byConsumer) {
    for (const call of calls) {
        const hits = uniqueRoutes.filter((r) => pathMatches(r.path, call.path) && (call.verb === "*" || call.verb === r.verb));
        if (hits.length === 0) unmatched.get(consumer)!.add(`${call.verb === "*" ? "" : call.verb + " "}${call.path}`);
        for (const r of hits) users.get(routeKey(r))!.add(consumer);
    }
}

// --- output -------------------------------------------------------------------
const mark = (s: Set<Consumer>, c: Consumer) => (s.has(c) ? "●" : "");
const counts = {
    total: uniqueRoutes.length,
    none: uniqueRoutes.filter((r) => users.get(routeKey(r))!.size === 0).length,
    webOnly: uniqueRoutes.filter((r) => { const u = users.get(routeKey(r))!; return u.size === 1 && u.has("web"); }).length,
    core: uniqueRoutes.filter((r) => { const u = users.get(routeKey(r))!; return ["loop", "mcp", "cli", "tvty"].some((c) => u.has(c as Consumer)); }).length,
};
const lines: string[] = [
    "# API routes and their consumers",
    "",
    "Generated by `npx tsx scripts/route-inventory.ts` — do not edit by hand. It reads the",
    "server's routes and every consumer's calls from the code; see the script's header for",
    "how calls are matched. A route no consumer calls may still be used by hand, by a hook",
    "or by a remote client; the table says what the code shows, nothing more.",
    "",
    "Consumers: **loop** (claude-loop), **mcp** (the MCP server), **cli** (the `aiball` CLI),",
    "**sim** (the board simulator), **web** (the web UI), **tvty** (the tvty terminal, from",
    "its checkout when present).",
    "",
    `**${counts.total} routes** · ${counts.core} called by loop, mcp, cli or tvty · ${counts.webOnly} by the web UI alone · ${counts.none} by no consumer in the code.`,
    "",
    "| Route | loop | mcp | cli | sim | web | tvty |",
    "|---|:-:|:-:|:-:|:-:|:-:|:-:|",
    ...uniqueRoutes.map((r) => {
        const u = users.get(routeKey(r))!;
        return `| \`${r.verb} ${r.path}\` | ${CONSUMERS.map((c) => mark(u, c)).join(" | ")} |`;
    }),
    "",
    "## Calls that match no route",
    "",
    "A path a consumer requests that no server route serves: dead code, a drifted path,",
    "or a route this script cannot read (a regex route, a path built at run time).",
    "",
];
for (const c of CONSUMERS) {
    const list = [...unmatched.get(c)!].sort();
    if (list.length) lines.push(`- **${c}**: ${list.map((p) => `\`${p}\``).join(", ")}`);
}
lines.push("");
const out = lines.join("\n");

if (args.includes("--check")) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== out) {
        console.error("docs/API-ROUTES.md is out of date: run `npx tsx scripts/route-inventory.ts`");
        process.exit(1);
    }
    console.log("docs/API-ROUTES.md is up to date");
} else {
    writeFileSync(OUT, out);
    console.log(`${counts.total} routes, ${counts.core} core, ${counts.webOnly} web-only, ${counts.none} uncalled → ${relative(ROOT, OUT)}`);
    console.log(`tvty sources: ${tvtyFiles.length ? `${tvtyFiles.length} files` : "not found"}`);
}
