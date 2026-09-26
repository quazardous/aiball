/**
 * The pieces of `scripts/route-inventory.ts` other code reuses (#3061): reading the
 * server's routes, reading the calls a piece of source makes, and matching a
 * call to routes. The script and the tvty contract test share them, so the two
 * cannot read a call differently.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type Verb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";
export interface Route { verb: Verb; path: string; file: string }
export interface Call { verb: Verb; path: string }
export const CONSUMERS = ["loop", "mcp", "cli", "sim", "web", "tvty"] as const;
export type Consumer = typeof CONSUMERS[number];

export function walk(dir: string, keep: (f: string) => boolean): string[] {
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
export const isSource = (f: string) => /\.(ts|vue)$/.test(f) && !/\.test\.ts$/.test(f);

// --- server routes ------------------------------------------------------------
/** Every `<router>.<verb>("<path>"` under src/api.ts, src/api/ and src/app.ts, deduplicated and sorted. */
export function readServerRoutes(root: string): Route[] {
    const routes: Route[] = [];
    for (const file of [join(root, "src/api.ts"), join(root, "src/app.ts"), ...walk(join(root, "src/api"), isSource)]) {
        const text = readFileSync(file, "utf8");
        const appLevel = file.endsWith("src/app.ts");
        for (const m of text.matchAll(/\b[A-Za-z]+\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
            const path = m[2]!;
            if (!path.startsWith("/")) continue;
            routes.push({ verb: m[1]!.toUpperCase() as Verb, path: appLevel || path.startsWith("/api/") ? path : `/api${path}`, file: relative(root, file) });
        }
    }
    return [...new Map(routes.map((r) => [routeKey(r), r])).values()]
        .sort((a, b) => a.path.localeCompare(b.path) || a.verb.localeCompare(b.verb));
}
export const routeKey = (r: { verb: Verb; path: string }) => `${r.verb} ${r.path}`;

// --- calls --------------------------------------------------------------------
/** Every `${…}` of a template literal, nested braces included, becomes `{}`. */
export function flattenTemplates(text: string): string {
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
export function normalizeCall(raw: string): string {
    return raw.split("?")[0]!
        .replace(/\{[^}/]*\}/g, "{}")
        .replace(/([^/])\{\}$/, "$1")
        .replace(/\/+$/, "") || "/";
}
/** The (verb, path) pairs a piece of source requests. */
/** Comments name paths without calling them: drop them (`//` only when it
 *  starts a line or follows a space, so `http://` in a string survives). */
export function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

export function callsIn(source: string): Call[] {
    const text = flattenTemplates(stripComments(source));
    const calls: Call[] = [];
    const seen = new Set<string>();
    const add = (verb: Verb, raw: string) => {
        const path = normalizeCall(raw);
        const k = `${verb} ${path}`;
        if (!seen.has(k)) { seen.add(k); calls.push({ verb, path }); }
    };
    // A verb literal shortly before the path: ("GET", "/api/…") or method: "POST", url: `/api/…`.
    for (const m of text.matchAll(/["'`](GET|POST|PUT|PATCH|DELETE)["'`][^;]{0,200}?[`"'](\/api\/[^`"'\s)]+)/g)) {
        add(m[1] as Verb, m[2]!);
    }
    // #3052 — a Rust client's verb is its method: `self.get("/api/…")`,
    // `self.post(&format!("/api/…"), …)`.
    for (const m of text.matchAll(/\.(get|post|put|patch|delete)\(\s*&?(?:format!\(\s*)?"(\/api\/[^"\s)]+)"/g)) {
        add(m[1]!.toUpperCase() as Verb, m[2]!);
    }
    for (const m of text.matchAll(/[`"'](\/api\/[^`"'\s)]+)/g)) {
        const path = normalizeCall(m[1]!);
        if (![...seen].some((k) => k.endsWith(` ${path}`))) add("*", m[1]!);
    }
    return calls;
}

// --- matching -----------------------------------------------------------------
/**
 * `strict`: a segment the caller builds at run time (`{}`) stands for a route
 * parameter only. Loose, it may also stand for a literal segment — the only
 * way to read `/api/messages/{id}/{verb}`, and never a certainty (#3052: read
 * loosely, `/api/tickets/{id}` also "called" `/api/tickets/purge`).
 */
export function pathMatches(route: string, call: string, strict: boolean): boolean {
    const r = route.split("/");
    const c = call.split("/");
    if (r.length !== c.length) return false;
    return r.every((seg, i) => seg === c[i] || seg.startsWith(":") || (!strict && c[i] === "{}"));
}

/** The routes `calls` certainly reach (●) and the ones they only may reach (◐). */
export function matchCalls(routes: readonly Route[], calls: readonly Call[]): { certain: Set<string>; maybe: Set<string>; unmatched: Set<string> } {
    const certain = new Set<string>(), maybe = new Set<string>(), unmatched = new Set<string>();
    for (const call of calls) {
        const verbOk = (r: { verb: Verb }) => call.verb === "*" || call.verb === r.verb;
        const hits = routes.filter((r) => pathMatches(r.path, call.path, true) && verbOk(r));
        const loose = hits.length > 0 ? [] : routes.filter((r) => pathMatches(r.path, call.path, false) && verbOk(r));
        if (hits.length === 0 && loose.length === 0) unmatched.add(`${call.verb === "*" ? "" : call.verb + " "}${call.path}`);
        for (const r of hits) certain.add(routeKey(r));
        for (const r of loose) maybe.add(routeKey(r));
    }
    return { certain, maybe, unmatched };
}

/** tvty's calls, read from its checkout's Rust sources; empty when it is not there. */
export function tvtyCalls(tvtyDir: string): Call[] {
    const files = walk(join(tvtyDir, "src"), (f) => f.endsWith(".rs"));
    return callsIn(files.map((f) => readFileSync(f, "utf8")).join("\n"));
}
