/**
 * Project-scoped tag catalog from config (#223). Tags can be declared in
 * the config files and are surfaced read-only (non-deletable) alongside
 * the editable DB tags — same spirit as the `formatting:` / `prompts:`
 * override chains, but the merge is COMPOSITE (every layer ADDS tags;
 * defaults always survive) instead of slot-replace.
 *
 * Three layers, low→high priority:
 *   0. shipped dist     config/defaults/tags.yaml      → tags:  (#223 cj2kp2 —
 *                       the classic catalog: bug/feature/urgent/… lives here)
 *   1. global per-user  ~/.config/aiball/config.yaml   → tags:
 *   2. per-project      <cwd>/.aiball.yaml             → tags:
 *
 * The config system is anchored on a SINGLE cwd (loadConfig walks up from
 * the daemon's cwd), so the daemon only ever sees ONE project's
 * `.aiball.yaml`. To declare tags for ARBITRARY projects (the UI's
 * project selector spans all of them) the global file uses a
 * project-keyed map:
 *
 *   tags:
 *     global:                          # apply to every project
 *       - bug
 *       - { name: mcp, color: "#7e57c2" }
 *     projects:
 *       aiball: [frontend, daemon]
 *       m2m:    [{ name: datamart, note: "BI sync" }]
 *
 * A bare list (`tags: [a, b]`) is shorthand for `tags: { global: [...] }`
 * in the global file; in a per-project `.aiball.yaml` it is attributed to
 * THAT file's project (so a repo's own component tags can live in-repo
 * without leaking to siblings).
 *
 * Ordering (david qzc7yr "l'ordre est donné par l'ordre dans la dernière
 * config qui parle"): a tag's position follows the LAST layer that
 * mentions it — restating a tag moves it to the end. Field-level
 * composite merge keeps an earlier color/note when a later layer omits it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { findConfigUpwards, globalConfigPath, loadConfig } from "./autopoll/config.js";

/**
 * Path to the shipped default tag catalog (#223 cj2kp2). config-tags.ts
 * lives in `src/`, so one dir up is the install root — same anchoring
 * trick as `defaultPingsPath()`.
 */
export function defaultTagsPath(): string {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    return join(root, "config", "defaults", "tags.yaml");
}

export interface ConfigTag {
    name: string;
    color: string | null;
    note: string | null;
}

interface TagsBlock {
    /** Tags applied to every project. */
    global: ConfigTag[];
    /** Per-project tags, keyed by project name. */
    projects: Record<string, ConfigTag[]>;
}

const EMPTY_BLOCK: TagsBlock = { global: [], projects: {} };

/** Accept a bare name (string) or an object `{ name, color?, note?/description? }`. */
function normalizeTag(raw: unknown): ConfigTag | null {
    if (typeof raw === "string") {
        const name = raw.trim();
        return name ? { name, color: null, note: null } : null;
    }
    if (raw && typeof raw === "object") {
        const o = raw as Record<string, unknown>;
        const name = typeof o.name === "string" ? o.name.trim() : "";
        if (!name) return null;
        const color = typeof o.color === "string" ? o.color : null;
        const note = typeof o.note === "string"
            ? o.note
            : typeof o.description === "string" ? o.description : null;
        return { name, color, note };
    }
    return null;
}

function normalizeList(raw: unknown): ConfigTag[] {
    if (!Array.isArray(raw)) return [];
    const out: ConfigTag[] = [];
    for (const r of raw) {
        const t = normalizeTag(r);
        if (t) out.push(t);
    }
    return out;
}

/**
 * Parse a raw `tags:` block into the `{ global, projects }` shape. A bare
 * list is attributed to `defaultProject` when given (the per-project file
 * case, so its tags never leak to siblings), else treated as `global`.
 */
export function loadTagsBlock(block: unknown, defaultProject: string | null = null): TagsBlock {
    if (Array.isArray(block)) {
        const list = normalizeList(block);
        return defaultProject
            ? { global: [], projects: { [defaultProject]: list } }
            : { global: list, projects: {} };
    }
    if (block && typeof block === "object") {
        const o = block as Record<string, unknown>;
        const projects: Record<string, ConfigTag[]> = {};
        if (o.projects && typeof o.projects === "object") {
            for (const [k, v] of Object.entries(o.projects as Record<string, unknown>)) {
                projects[k] = normalizeList(v);
            }
        }
        return { global: normalizeList(o.global), projects };
    }
    return EMPTY_BLOCK;
}

function readTagsBlock(yamlPath: string, defaultProject: string | null = null): TagsBlock {
    try {
        const parsed = parseYaml(readFileSync(yamlPath, "utf8")) as { tags?: unknown };
        return loadTagsBlock(parsed?.tags, defaultProject);
    } catch {
        return EMPTY_BLOCK;
    }
}

/** Tags a block contributes for a given project: global ⊕ projects[project]. */
function tagsFor(block: TagsBlock, project: string | null): ConfigTag[] {
    const proj = project ? block.projects[project] ?? [] : [];
    return [...block.global, ...proj];
}

/**
 * Merge layers low→high. Restating a tag (same name) field-merges its
 * properties (later non-null wins, earlier value kept when omitted) AND
 * moves it to the end so the resolved order follows the last layer that
 * mentions it.
 */
function mergeTags(...lists: ConfigTag[][]): ConfigTag[] {
    const byName = new Map<string, ConfigTag>();
    for (const list of lists) {
        for (const t of list) {
            const prev = byName.get(t.name);
            byName.delete(t.name);
            byName.set(t.name, {
                name: t.name,
                color: t.color ?? prev?.color ?? null,
                note: t.note ?? prev?.note ?? null,
            });
        }
    }
    return [...byName.values()];
}

/** Read all config layers once. Cheap (files <10KB); re-read per request. */
function layerBlocks(): { shipped: TagsBlock; global: TagsBlock; project: TagsBlock } {
    const shipped = readTagsBlock(defaultTagsPath());
    const global = readTagsBlock(globalConfigPath());
    const projectPath = findConfigUpwards(process.cwd());
    const project = projectPath
        ? readTagsBlock(projectPath, loadConfig(process.cwd()).consumer.project)
        : EMPTY_BLOCK;
    return { shipped, global, project };
}

/**
 * Resolved config tags for one project (null = global-only view). Merges
 * the shipped → global → per-project layers in priority order.
 */
export function resolveConfigTags(project: string | null): ConfigTag[] {
    const { shipped, global, project: projectBlock } = layerBlocks();
    return mergeTags(
        tagsFor(shipped, project),
        tagsFor(global, project),
        tagsFor(projectBlock, project),
    );
}

/**
 * Every config tag name across all layers and projects. These names are
 * config-owned: the DB CRUD endpoints refuse to mutate a DB row whose
 * name collides (a config tag must be edited in the yaml, not the UI).
 */
export function configTagNames(): Set<string> {
    const names = new Set<string>();
    const { shipped, global, project } = layerBlocks();
    for (const block of [shipped, global, project]) {
        for (const t of block.global) names.add(t.name);
        for (const list of Object.values(block.projects)) {
            for (const t of list) names.add(t.name);
        }
    }
    return names;
}

/**
 * The shipped default catalog as a flat list (#223 cj2kp2). Read by the DB
 * bootstrap to seed tag ROWS on a fresh database — config is the canonical
 * definition, the DB rows exist only so these everyday tags stay
 * applicable to tickets (the apply path is FK-by-id). Mirrors the file, so
 * the seeded colors match what the catalog renders.
 */
export function loadShippedDefaultTags(): ConfigTag[] {
    return readTagsBlock(defaultTagsPath()).global;
}
