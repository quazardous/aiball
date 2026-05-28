/**
 * #565 — welcome kit builder. Pure I/O scanning of the `welcome/` tree
 * shipped at the install root (`<install>/welcome/<type>/`), composed
 * into a stable JSON shape the MCP tool returns to the agent.
 *
 * Layout convention (per david `87dp6p` — each `<type>` directory is
 * autonomous, no inheritance, no overlay):
 *
 *     welcome/
 *       <type>/                e.g. "public", "private"
 *         WELCOME.md           master "tone" doc (REQUIRED for a
 *                              type to be considered valid).
 *         templates/           optional. files the agent is invited
 *                              to drop into the project at
 *                              `path_hint = <basename>` IF the file
 *                              is missing there. Never overwrite.
 *
 * Discovery — `availableTypes(installRoot)` lists every subfolder of
 * `welcome/` that owns a `WELCOME.md`. Folders without WELCOME.md are
 * considered drafts and stay invisible. That gives us "add a type =
 * create a folder + a WELCOME.md, zero code change".
 *
 * Note : earlier iterations carried a `rules/` subfolder, but david
 * `87dp6p` formalised the type structure as just `WELCOME.md +
 * templates/`. The "rules" are now part of the master tone doc.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
    /** Master `WELCOME.md` body for the type (tone doc). Read FIRST
     *  by the agent ; it carries the type's rules + the spirit in
     *  which to operate. */
    welcome_md: string;
    /** Scaffolding templates the agent can drop into the project. May
     *  be empty (the type's whole proposition can be "tone only"). */
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
 * Assemble the kit for a given (installRoot, project_type). Throws
 * `UnknownProjectTypeError` if the type isn't discovered under
 * `welcome/`. The `welcome_md` field is the master `WELCOME.md` body
 * — the agent reads it first to grasp the tone before adopting
 * templates.
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
        templates: loadTemplates(typeDir),
    };
}
