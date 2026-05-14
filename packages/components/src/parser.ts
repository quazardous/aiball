/**
 * Load + validate `components.yaml` from the project root.
 *
 * Resolution strategy:
 *   1. Honor an explicit `--config <path>` (handled by cli.ts).
 *   2. Otherwise walk up from cwd looking for `components.yaml`.
 *   3. If we hit the FS root without finding one → null.
 *
 * The format is permissive YAML — we validate the shape minimally so
 * a typo in `extractor: jons` fails loudly instead of silently
 * extracting nothing.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export type ExtractorKind = "json" | "text" | "regex" | "git";

const KNOWN_EXTRACTORS = new Set<ExtractorKind>(["json", "text", "regex", "git"]);

export interface Component {
    key: string;
    name?: string;
    file?: string;
    path?: string;
    extractor: ExtractorKind;
    main?: boolean;
    changelog?: string;
}

export interface ComponentsConfig {
    project?: string;
    components: Component[];
    /** Absolute path to the `components.yaml` we loaded. */
    configPath: string;
    /** Directory that contains `components.yaml` — the project root for file resolution. */
    projectRoot: string;
}

/**
 * Walk up from `start` until we find `components.yaml` or hit the FS
 * root. Returns the absolute path to the file or null.
 */
export function findConfigUpwards(start: string): string | null {
    let dir = resolve(start);
    const rootPath = parsePath(dir).root;
    // Safety guard so a busted FS layout can't loop forever.
    for (let i = 0; i < 64; i++) {
        const candidate = join(dir, "components.yaml");
        if (existsSync(candidate)) return candidate;
        if (dir === rootPath) return null;
        const next = dirname(dir);
        if (next === dir) return null;
        dir = next;
    }
    return null;
}

export function loadConfig(explicitPath: string | null = null, cwd: string = process.cwd()): ComponentsConfig {
    const configPath = explicitPath
        ? resolve(explicitPath)
        : findConfigUpwards(cwd);
    if (!configPath) {
        throw new Error(
            "components.yaml not found — pass --config <path> or create one at the project root",
        );
    }
    if (!existsSync(configPath)) {
        throw new Error(`components.yaml not found at ${configPath}`);
    }
    const raw = readFileSync(configPath, "utf8");
    let doc: unknown;
    try {
        doc = parseYaml(raw);
    } catch (e) {
        throw new Error(`failed to parse ${configPath}: ${(e as Error).message}`);
    }
    if (!doc || typeof doc !== "object") {
        throw new Error(`${configPath}: top-level must be a mapping`);
    }
    const d = doc as { project?: unknown; components?: unknown };
    if (!Array.isArray(d.components)) {
        throw new Error(`${configPath}: 'components' must be a list`);
    }
    const components: Component[] = d.components.map((raw, idx) => {
        if (!raw || typeof raw !== "object") {
            throw new Error(`${configPath}: components[${idx}] must be a mapping`);
        }
        const c = raw as Record<string, unknown>;
        if (typeof c.key !== "string" || !c.key) {
            throw new Error(`${configPath}: components[${idx}].key is required`);
        }
        const ext = typeof c.extractor === "string" ? c.extractor : "json";
        if (!KNOWN_EXTRACTORS.has(ext as ExtractorKind)) {
            throw new Error(
                `${configPath}: components[${idx}].extractor '${ext}' unknown (valid: ${[...KNOWN_EXTRACTORS].join(", ")})`,
            );
        }
        return {
            key: c.key,
            name: typeof c.name === "string" ? c.name : undefined,
            file: typeof c.file === "string" ? c.file : undefined,
            path: typeof c.path === "string" ? c.path : undefined,
            extractor: ext as ExtractorKind,
            main: c.main === true,
            changelog: typeof c.changelog === "string" ? c.changelog : undefined,
        };
    });
    // Detect duplicate keys.
    const seen = new Set<string>();
    for (const c of components) {
        if (seen.has(c.key)) {
            throw new Error(`${configPath}: duplicate component key '${c.key}'`);
        }
        seen.add(c.key);
    }
    return {
        project: typeof d.project === "string" ? d.project : undefined,
        components,
        configPath,
        projectRoot: dirname(configPath),
    };
}

export function findComponent(cfg: ComponentsConfig, key: string): Component {
    const c = cfg.components.find((x) => x.key === key);
    if (!c) {
        throw new Error(
            `no component with key '${key}' (have: ${cfg.components.map((x) => x.key).join(", ")})`,
        );
    }
    return c;
}
