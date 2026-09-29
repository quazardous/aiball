/**
 * #3069 — the bus's published contract, generated from the code: an OpenRPC
 * document for the methods (their params from their zod schemas, who may call
 * them) and an AsyncAPI document for the subjects. Descriptions are the doc
 * comments above each `defineMethod` in `src/bus/methods/`, read from the
 * source: written once, where the method is. `scripts/bus-contract.ts` writes
 * both to `docs/`, and a test fails when those files are stale.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BUS_PATH, BUS_VERSION, RPC_ERRORS } from "../bus-protocol.js";
import { ERROR_CODES } from "../domain.js";
import { getMethod, methodNames } from "./methods.js";
import { subjectSpecs } from "./subscriptions.js";
import "./register.js";

/** A doc comment's text: the `*` margins gone, lines joined, `#NNN — ` refs dropped. */
function commentText(raw: string): string {
    return raw
        .split("\n")
        .map((l) => l.replace(/^\s*\*\s?/, "").trim())
        .join(" ")
        .replace(/#\d+(?:\s*\/\s*#\d+)*\s*[—-]\s*/g, "")
        .replace(/\(#\d+\)/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[a-z]/, (c) => c.toUpperCase());
}

let described: Map<string, string> | null = null;

/** Each method's description, from the doc comment right above its definition. */
export function methodDescriptions(): Map<string, string> {
    if (described) return described;
    const out = new Map<string, string>();
    const dir = join(import.meta.dirname, "methods");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts")).sort()) {
        const text = readFileSync(join(dir, f), "utf8");
        // `/** … */` then `defineMethod({ name: "x"` — or a loop defining several: `for (const [name, …] of [["a", …], ["b", …]]`.
        // The comment may not contain `*/`: else it would reach back over code to an earlier comment.
        for (const m of text.matchAll(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*((?:export\s+)?(?:const\s+\w+\s*=\s*)?defineMethod\(\{\s*name:\s*"([^"]+)"|for \(const \[name[^\]]*\] of \[([^\n]+)\])/g)) {
            const doc = commentText(m[1]);
            if (m[3]) out.set(m[3], doc);
            else for (const n of (m[4] ?? "").matchAll(/\["([a-z_.]+)"/g)) out.set(n[1], doc);
        }
    }
    described = out;
    return out;
}

function version(): string {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version: string };
    return pkg.version;
}

function paramsOf(schema: z.ZodType): { name: string; required: boolean; schema: unknown }[] {
    const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as { properties?: Record<string, unknown>; required?: string[] };
    return Object.entries(json.properties ?? {})
        .map(([name, s]) => ({ name, required: (json.required ?? []).includes(name), schema: s }))
        .sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
}

export function openRpcDocument(): Record<string, unknown> {
    const docs = methodDescriptions();
    return {
        openrpc: "1.3.2",
        info: {
            title: "aiball bus",
            version: version(),
            description: `JSON-RPC 2.0 over a WebSocket at ${BUS_PATH}, protocol version ${BUS_VERSION}. See docs/API-BUS.md.`,
        },
        methods: methodNames().map((name) => {
            const m = getMethod(name)!;
            return {
                name,
                description: docs.get(name) ?? "",
                paramStructure: "by-name",
                params: paramsOf(m.params),
                result: { name: "result", schema: {} },
                "x-callers": m.who,
                ...(m.relayed === false && !m.machine ? { "x-relayed": false } : {}),
                // #3284 — acts on the machine that answers: a proxy node answers it itself.
                ...(m.machine ? { "x-machine": true } : {}),
                // #3293 — a proxy node answers it for a loop of its own machine.
                ...(m.nodeLocal ? { "x-node-local": true } : {}),
                ...(m.scope ? { "x-scope": m.scope } : {}),
            };
        }),
        components: {
            errors: {
                ...Object.fromEntries(Object.entries(RPC_ERRORS).map(([k, code]) => [k, { code, message: k.toLowerCase().replace(/_/g, " ") }])),
                refusal: {
                    code: 400,
                    message: "a method's refusal: the JSON-RPC code is the HTTP status it matches, data.code is aiball's error code",
                    data: { codes: Object.values(ERROR_CODES).sort() },
                },
            },
        },
    };
}

export function asyncApiDocument(): Record<string, unknown> {
    const channels: Record<string, unknown> = {};
    for (const spec of [...subjectSpecs()].sort((a, b) => a.pattern.localeCompare(b.pattern))) {
        const address = spec.pattern.replace("*", "{id}");
        channels[spec.pattern] = {
            address,
            parameters: { id: { description: spec.wildcard ? "an id, or * for all (those added later too)" : "an id" } },
            messages: {
                value: { name: "value", summary: spec.doc?.value ?? "" },
                event: { name: "event", summary: spec.doc?.event ?? "" },
            },
            ...(spec.replay === false ? { "x-replay": false } : {}),
            // #3294 — about the machine that answers: a proxy node serves it for its own.
            ...(spec.machine ? { "x-machine": true } : {}),
        };
    }
    return {
        asyncapi: "3.0.0",
        info: {
            title: "aiball bus subjects",
            version: version(),
            description: "bus.subscribe gives a subject's value, then bus.event notifications with each change as data. See docs/API-BUS.md.",
        },
        channels,
    };
}
