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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CONSUMERS, callsIn, isSource, pathMatches, readServerRoutes, routeKey, tvtyCalls, walk, type Call, type Consumer, type Verb } from "../src/devtools/route-inventory-lib.js";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const tvtyAt = args.indexOf("--tvty");
const TVTY = resolve(ROOT, tvtyAt >= 0 ? args[tvtyAt + 1]! : "../tvty");
const OUT = join(ROOT, "docs/API-ROUTES.md");
const uniqueRoutes = readServerRoutes(ROOT);

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
byConsumer.get("tvty")!.push(...tvtyCalls(TVTY));

const users = new Map<string, Set<Consumer>>(uniqueRoutes.map((r) => [routeKey(r), new Set()]));
/** Routes a consumer may call through a segment built at run time: a possible call, not a certain one. */
const maybe = new Map<string, Set<Consumer>>(uniqueRoutes.map((r) => [routeKey(r), new Set()]));
const unmatched = new Map<Consumer, Set<string>>(CONSUMERS.map((c) => [c, new Set()]));
for (const [consumer, calls] of byConsumer) {
    for (const call of calls) {
        const verbOk = (r: { verb: Verb }) => call.verb === "*" || call.verb === r.verb;
        const hits = uniqueRoutes.filter((r) => pathMatches(r.path, call.path, true) && verbOk(r));
        const loose = hits.length > 0 ? [] : uniqueRoutes.filter((r) => pathMatches(r.path, call.path, false) && verbOk(r));
        if (hits.length === 0 && loose.length === 0) unmatched.get(consumer)!.add(`${call.verb === "*" ? "" : call.verb + " "}${call.path}`);
        for (const r of hits) users.get(routeKey(r))!.add(consumer);
        for (const r of loose) maybe.get(routeKey(r))!.add(consumer);
    }
}

// --- output -------------------------------------------------------------------
const mark = (s: Set<Consumer>, m: Set<Consumer>, c: Consumer) => (s.has(c) ? "●" : m.has(c) ? "◐" : "");
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
    "● the consumer calls the route. ◐ it may: its call builds a segment at run time",
    "(`/api/messages/{id}/{verb}`), which could be this route or a sibling.",
    "",
    `**${counts.total} routes** · ${counts.core} called by loop, mcp, cli or tvty · ${counts.webOnly} by the web UI alone · ${counts.none} by no consumer in the code.`,
    "",
    "| Route | loop | mcp | cli | sim | web | tvty |",
    "|---|:-:|:-:|:-:|:-:|:-:|:-:|",
    ...uniqueRoutes.map((r) => {
        const u = users.get(routeKey(r))!;
        const m = maybe.get(routeKey(r))!;
        return `| \`${r.verb} ${r.path}\` | ${CONSUMERS.map((c) => mark(u, m, c)).join(" | ")} |`;
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
    const tvtyFileCount = walk(join(TVTY, "src"), (f) => f.endsWith(".rs")).length;
    console.log(`tvty sources: ${tvtyFileCount ? `${tvtyFileCount} files` : "not found"}`);
}
