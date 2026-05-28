/**
 * #565 — welcome kit builder. Pure I/O scanning of the `welcome/` tree
 * shipped at the install root (`<install>/welcome/<type>/`), composed
 * into a stable JSON shape the MCP tool returns to the agent.
 *
 * Layout convention (each `<type>` directory is autonomous — no
 * inheritance, no overlay):
 *
 *     welcome/
 *       <type>/                e.g. "public", "private"
 *         WELCOME.md           master "tone" doc (required for a type
 *                              to be considered valid).
 *         rules/               optional. .md files seeded into the
 *                              agent's persistent memory.
 *         templates/           optional. files the agent is invited
 *                              to drop into the project at
 *                              `path_hint = <basename>` IF the file
 *                              is missing there. Never overwrite.
 *
 * Discovery — `availableTypes(installRoot)` lists every subfolder of
 * `welcome/` that owns a `WELCOME.md`. Folders without WELCOME.md are
 * skipped (they're considered drafts). That gives us "add a type =
 * create a folder + a WELCOME.md, zero code change", per david `87dp6p`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** A rule file under `welcome/<type>/rules/`. */
export interface WelcomeRule {
    /** Filename without `.md` (slug used for memory tagging). */
    name: string;
    /** First paragraph of the body (post-front-matter / post-comment),
     *  intended as a one-liner the agent can scan without reading the
     *  detail. */
    summary: string;
    /** Full markdown body, intent comment included. The agent reads
     *  this when absorbing the rule into memory. */
    detail: string;
}

/** A template file under `welcome/<type>/templates/`. */
export interface WelcomeTemplate {
    /** Filename without extension (slug; e.g. `README`, `CHANGELOG`). */
    name: string;
    /** Where the agent is invited to drop the file in the project,
     *  relative to the project root. Defaults to the basename of the
     *  template file (`README.md`, `CHANGELOG.md`, …). */
    path_hint: string;
    /** Raw markdown / text content. Starts with an HTML comment
     *  explaining the template's intent (per david `87dp6p`). */
    source_md: string;
}

/** Full kit returned to the agent. */
export interface WelcomeKit {
    /** The validated `project_type`. */
    project_type: string;
    /** Every type the daemon's install discovered under `welcome/`.
     *  Surfacing this lets a user editing `.aiball.yaml` know what's
     *  valid without `ls`-ing the daemon's install dir. */
    available_types: string[];
    /** Master `WELCOME.md` body for the type (tone doc). */
    welcome_md: string;
    rules: WelcomeRule[];
    templates: WelcomeTemplate[];
}

/** Error thrown when the requested `project_type` is not a valid type
 *  (no folder under `welcome/<type>` with a `WELCOME.md`). */
export class UnknownProjectTypeError extends Error {
    readonly availableTypes: string[];
    constructor(requested: string, available: string[]) {
        super(
            `unknown project_type "${requested}" (available: [${available.join(", ")}])`,
        );
        this.name = "UnknownProjectTypeError";
        this.availableTypes = available;
    }
}

/** Default type when `.aiball.yaml` carries no `project_type`. Strict
 *  by design (fail-safe : if the user forgets, scrubbing rules apply
 *  rather than no rules). */
export const DEFAULT_PROJECT_TYPE = "public";

/** Resolved path to the welcome root for an install. */
export function welcomeRoot(installRoot: string): string {
    return join(installRoot, "welcome");
}

/**
 * List every type directory under `welcome/` that owns a `WELCOME.md`.
 * Sorted alphabetically so the response order is deterministic. Returns
 * an empty list if `welcome/` is missing (e.g. install layout that
 * never shipped the kit).
 */
export function availableTypes(installRoot: string): string[] {
    const root = welcomeRoot(installRoot);
    if (!existsSync(root)) return [];
    const types: string[] = [];
    for (const name of readdirSync(root)) {
        if (name.startsWith(".")) continue;
        const dir = join(root, name);
        let s;
        try {
            s = statSync(dir);
        } catch {
            continue;
        }
        if (!s.isDirectory()) continue;
        if (!existsSync(join(dir, "WELCOME.md"))) continue;
        types.push(name);
    }
    return types.sort();
}

/**
 * Read every `.md` under `welcome/<type>/rules/`. Skipped silently if
 * the dir is missing. Summary = first non-empty line that isn't an
 * HTML comment line or a heading marker; falls back to the heading
 * if no plain paragraph is present.
 */
function loadRules(typeDir: string): WelcomeRule[] {
    const dir = join(typeDir, "rules");
    if (!existsSync(dir)) return [];
    const out: WelcomeRule[] = [];
    for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith(".md")) continue;
        if (name.startsWith(".")) continue;
        const full = join(dir, name);
        let body: string;
        try {
            body = readFileSync(full, "utf8");
        } catch {
            continue;
        }
        out.push({
            name: name.replace(/\.md$/, ""),
            summary: extractSummary(body),
            detail: body,
        });
    }
    return out;
}

/**
 * Read every regular file under `welcome/<type>/templates/`. Skipped
 * silently if the dir is missing. `path_hint` defaults to the
 * basename — the agent drops the file at the project root unless it
 * decides otherwise.
 */
function loadTemplates(typeDir: string): WelcomeTemplate[] {
    const dir = join(typeDir, "templates");
    if (!existsSync(dir)) return [];
    const out: WelcomeTemplate[] = [];
    for (const name of readdirSync(dir).sort()) {
        if (name.startsWith(".")) continue;
        const full = join(dir, name);
        let s;
        try {
            s = statSync(full);
        } catch {
            continue;
        }
        if (!s.isFile()) continue;
        let content: string;
        try {
            content = readFileSync(full, "utf8");
        } catch {
            continue;
        }
        out.push({
            name: name.replace(/\.[^.]+$/, "") || name,
            path_hint: name,
            source_md: content,
        });
    }
    return out;
}

/**
 * Extract a short summary from a rule's markdown body. Strategy:
 *   - Skip leading HTML comments (`<!-- … -->`), whitespace, and
 *     heading lines (`# …`).
 *   - Return the first non-empty plain text line, trimmed to its
 *     first 200 chars.
 *   - Fall back to the first heading text if no plain paragraph
 *     exists.
 *   - Return `""` if the body has nothing usable.
 */
function extractSummary(body: string): string {
    const stripped = body.replace(/<!--[\s\S]*?-->/g, "").trim();
    const lines = stripped.split(/\r?\n/);
    let firstHeading = "";
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith("#")) {
            if (!firstHeading) {
                firstHeading = line.replace(/^#+\s*/, "");
            }
            continue;
        }
        // First non-heading text — that's the summary.
        return line.length > 200 ? `${line.slice(0, 197)}…` : line;
    }
    return firstHeading;
}

/**
 * Assemble the kit for a given (installRoot, project_type). Throws
 * `UnknownProjectTypeError` if the type isn't discovered under
 * `welcome/`. The `welcome_md` field is the master `WELCOME.md` body
 * — the agent reads it first to grasp the tone before applying rules
 * or proposing templates.
 */
export function buildWelcomeKit(
    installRoot: string,
    requestedType: string | null | undefined,
): WelcomeKit {
    const types = availableTypes(installRoot);
    const project_type = (requestedType ?? "").trim() || DEFAULT_PROJECT_TYPE;
    if (!types.includes(project_type)) {
        throw new UnknownProjectTypeError(project_type, types);
    }
    const typeDir = join(welcomeRoot(installRoot), project_type);
    const welcome_md = readFileSync(join(typeDir, "WELCOME.md"), "utf8");
    return {
        project_type,
        available_types: types,
        welcome_md,
        rules: loadRules(typeDir),
        templates: loadTemplates(typeDir),
    };
}
