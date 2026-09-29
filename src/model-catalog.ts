/**
 * #3288 — the Claude models there are, from an open list that needs no key:
 * models.dev (`https://models.dev/api.json`: names, release dates, prices),
 * LiteLLM's price table as a fallback. Read once when the daemon starts and
 * kept on disk, so a start without network still has the last list known.
 * Third-party lists, kept by their communities: a date or a price may lag,
 * so what is shown names its source.
 *
 * "Newer" is read from the ids themselves, the family and the version
 * (`claude-opus-5-5` is Opus 5.5, newer than Opus 5): the same reading as the
 * short name the bar shows, and one that LiteLLM (no dates) supports too.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIBALL_HOME } from "./paths.js";
import { modelShortName } from "./model-name.js";

/** USD per million tokens. */
export interface ModelCost { input: number; output: number }

export interface CatalogModel {
    id: string;
    /** The short name, as the bar shows it: "Opus 5.5". */
    name: string;
    family: string;
    version: number[];
    released: string | null;
    cost: ModelCost | null;
}

export type CatalogSource = "models.dev" | "litellm";

export interface ModelCatalog { source: CatalogSource; fetched_at: string; models: CatalogModel[] }

const MODELS_DEV = "https://models.dev/api.json";
const LITELLM = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

let catalog: ModelCatalog | null = null;

/** Family and version of a model id, from its short name; null when the id does not read as one. */
export function familyOf(id: string): { family: string; version: number[] } | null {
    const name = modelShortName(id.replace(/\[[^\]]+\]$/, ""));
    const m = /^([A-Za-z][A-Za-z ]*?) (\d+(?:\.\d+)*)$/.exec(name);
    return m ? { family: m[1]!, version: m[2]!.split(".").map(Number) } : null;
}

function entry(id: string, released: string | null, cost: ModelCost | null): CatalogModel | null {
    // A dated id (`-20251001`) is the same model as its undated one: kept once.
    if (/-\d{8}$/.test(id) || /latest/.test(id)) return null;
    const f = familyOf(id);
    return f ? { id, name: modelShortName(id), ...f, released, cost } : null;
}

/** models.dev's `api.json`: its `anthropic` provider's models. */
export function parseModelsDev(json: unknown): CatalogModel[] {
    const models = (json as { anthropic?: { models?: Record<string, { release_date?: unknown; cost?: { input?: unknown; output?: unknown } }> } })?.anthropic?.models ?? {};
    return Object.entries(models).flatMap(([id, m]) => {
        const c = m.cost;
        const cost = c && typeof c.input === "number" && typeof c.output === "number" ? { input: c.input, output: c.output } : null;
        const e = entry(id, typeof m.release_date === "string" ? m.release_date : null, cost);
        return e ? [e] : [];
    });
}

/** LiteLLM's price table: its `anthropic` entries, priced per token. */
export function parseLiteLLM(json: unknown): CatalogModel[] {
    const rows = (json ?? {}) as Record<string, { litellm_provider?: unknown; input_cost_per_token?: unknown; output_cost_per_token?: unknown }>;
    return Object.entries(rows).flatMap(([id, r]) => {
        if (!r || typeof r !== "object" || r.litellm_provider !== "anthropic") return [];
        const cost = typeof r.input_cost_per_token === "number" && typeof r.output_cost_per_token === "number"
            ? { input: Math.round(r.input_cost_per_token * 1e8) / 100, output: Math.round(r.output_cost_per_token * 1e8) / 100 }
            : null;
        const e = entry(id, null, cost);
        return e ? [e] : [];
    });
}

function cachePath(): string {
    return join(AIBALL_HOME, "models-catalog.json");
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
}

/**
 * Read the catalog: models.dev, else LiteLLM, else the copy kept on disk.
 * Never throws: without any of them, there is no catalog, and the bar says
 * nothing about newer models.
 */
export async function loadModelCatalog(timeoutMs = 10_000): Promise<ModelCatalog | null> {
    for (const [source, url, parse] of [["models.dev", MODELS_DEV, parseModelsDev], ["litellm", LITELLM, parseLiteLLM]] as const) {
        try {
            const models = parse(await fetchJson(url, timeoutMs));
            if (models.length === 0) continue;
            catalog = { source, fetched_at: new Date().toISOString(), models };
            try { writeFileSync(cachePath(), JSON.stringify(catalog)); } catch { /* the copy is a convenience */ }
            return catalog;
        } catch { /* the next source */ }
    }
    try {
        catalog = JSON.parse(readFileSync(cachePath(), "utf8")) as ModelCatalog;
    } catch { catalog = null; }
    return catalog;
}

/** Tests only: the catalog as given. */
export function setModelCatalogForTests(c: ModelCatalog | null): void {
    catalog = c;
}

function cmp(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] ?? 0) - (b[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

/**
 * What the catalog says of the model `id` runs: its price, and the newest
 * model of its family when one is newer. Null without a catalog.
 */
export function modelFacts(id: string): { cost: ModelCost | null; newer: { id: string; name: string; cost: ModelCost | null } | null; source: CatalogSource } | null {
    if (!catalog) return null;
    const f = familyOf(id);
    const base = id.replace(/\[[^\]]+\]$/, "").replace(/-\d{8}$/, "");
    const own = catalog.models.find((m) => m.id === base) ?? null;
    let newest: CatalogModel | null = null;
    if (f) {
        for (const m of catalog.models) {
            if (m.family !== f.family || cmp(m.version, f.version) <= 0) continue;
            if (!newest || cmp(m.version, newest.version) > 0) newest = m;
        }
    }
    return {
        cost: own?.cost ?? null,
        newer: newest ? { id: newest.id, name: newest.name, cost: newest.cost } : null,
        source: catalog.source,
    };
}
