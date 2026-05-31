/**
 * #565 — welcome kit builder. Pure I/O scanning of the `welcome/` tree
 * shipped at the install root (`<install>/welcome/<type>/`), composed
 * into a stable JSON shape the MCP tools return to the agent.
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
 * V1.2 split (david `zrdffz`) — token-efficiency : `welcome()` returns
 * only the manifest of templates (`{name, path_hint}`), the agent
 * fetches the bodies on-demand via `welcome_template({name})`. Bodies
 * are not paid until the agent actually applies a template.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findConfigUpwards, globalConfigPath } from "./autopoll/config.js";
import { defaultPingsPath } from "./claude-loop/state.js";
import { resolveFormatting } from "./formatting.js";

/**
 * Manifest entry for a template — name + drop location, no body.
 * Lightweight by design (V1.2 token-efficiency split, david `zrdffz` :
 * « `templates[]` ça renvoit juste une liste de template dispo (on
 * avait dit token effective), il faut un outil pour récup le
 * template »). The full body is fetched on-demand via
 * `getWelcomeTemplate(installRoot, project_type, name)`.
 */
export interface WelcomeTemplateManifest {
    /** Filename without extension (slug; e.g. `README`, `CHANGELOG`). */
    name: string;
    /** Where the agent is invited to drop the file in the project,
     *  relative to the project root. Defaults to the basename of the
     *  template file (`README.md`, `CHANGELOG.md`, …). */
    path_hint: string;
}

/** Full template (manifest + body) returned by `welcome_template`. */
export interface WelcomeTemplate extends WelcomeTemplateManifest {
    /** Raw markdown / text content. Starts with an HTML comment
     *  explaining the template's intent (per david `87dp6p`). */
    source_md: string;
}

/** Full kit returned to the agent by `welcome()`. */
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
    /** Manifest of scaffolding templates (name + path_hint only). The
     *  agent fetches the bodies on-demand via `welcome_template({name})`
     *  — V1.2 token-efficiency : only pays the bodies it actually
     *  applies (typically 1-2 out of N), instead of N inline. May be
     *  empty (a type's whole proposition can be "tone only"). */
    templates: WelcomeTemplateManifest[];
    /** #667 david — effective formatting patterns for this project
     *  (ticket / comment / mention ID shapes). The shipped defaults are
     *  `#N` / `#C.hashid` / `@agent-id` ; a project's `.aiball.yaml`
     *  can override these. The agent reads `canonical` to know how
     *  to write IDs, and `match` (regex) to recognise them in incoming
     *  text. Field is present even when the project uses the defaults
     *  — so the skill / agent never has to hardcode the shapes. */
    formatting: { id: string; match: string; canonical: string }[];
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

/** Error thrown when `welcome_template({name})` asks for a name that
 *  doesn't exist in the type's `templates/` folder. */
export class UnknownTemplateError extends Error {
    readonly availableTemplates: string[];
    constructor(requested: string, type: string, available: string[]) {
        super(
            `unknown template "${requested}" for project_type "${type}" (available: [${available.join(", ")}])`,
        );
        this.name = "UnknownTemplateError";
        this.availableTemplates = available;
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
 * Resolve + validate `project_type` against the install's discovered
 * types. Empty / whitespace falls back to `DEFAULT_PROJECT_TYPE`.
 * Throws `UnknownProjectTypeError` on a name not present under
 * `welcome/<name>/WELCOME.md`. Shared by `buildWelcomeKit` and
 * `getWelcomeTemplate` so both go through the same gate.
 */
function resolveProjectType(installRoot: string, requested: string | null | undefined): {
    project_type: string;
    available_types: string[];
} {
    const available = availableTypes(installRoot);
    const project_type = (requested ?? "").trim() || DEFAULT_PROJECT_TYPE;
    if (!available.includes(project_type)) {
        throw new UnknownProjectTypeError(project_type, available);
    }
    return { project_type, available_types: available };
}

/**
 * Scan a type's `templates/` directory and return the manifest entries
 * (no bodies). `path_hint` defaults to the file basename. Sorted by
 * filename for deterministic order. Empty list if the dir is missing.
 */
function loadTemplateManifest(typeDir: string): WelcomeTemplateManifest[] {
    const dir = join(typeDir, "templates");
    if (!existsSync(dir)) return [];
    const out: WelcomeTemplateManifest[] = [];
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
        out.push({
            name: name.replace(/\.[^.]+$/, "") || name,
            path_hint: name,
        });
    }
    return out;
}

/**
 * Assemble the kit for a given (installRoot, project_type). Throws
 * `UnknownProjectTypeError` if the type isn't discovered under
 * `welcome/`. The `welcome_md` field is the master `WELCOME.md` body
 * — the agent reads it first to grasp the tone before adopting
 * templates. V1.2 : `templates[]` is a manifest only (`{name,
 * path_hint}`) ; pay the body via `getWelcomeTemplate`.
 */
export function buildWelcomeKit(
    installRoot: string,
    requestedType: string | null | undefined,
): WelcomeKit {
    const { project_type, available_types } = resolveProjectType(installRoot, requestedType);
    const typeDir = join(welcomeRoot(installRoot), project_type);
    const welcome_md = readFileSync(join(typeDir, "WELCOME.md"), "utf8");
    // #667 — resolve the effective formatting patterns from the same
    // 3-layer chain as /api/config (shipped defaults → global → project).
    // Surfaced here so agents reading the welcome kit also get the ID
    // shapes (no separate round-trip to /api/config from the MCP side).
    const formatting = resolveFormatting({
        shippedDefaultsPath: defaultPingsPath(),
        globalConfigPath: globalConfigPath(),
        projectConfigPath: findConfigUpwards(process.cwd()),
    }).map((p) => ({ id: p.id, match: p.match, canonical: p.canonical }));
    return {
        project_type,
        available_types,
        welcome_md,
        templates: loadTemplateManifest(typeDir),
        formatting,
    };
}

/**
 * Fetch a single template (manifest + body) by name from a given
 * type's `templates/` folder. Throws `UnknownProjectTypeError` if the
 * type doesn't exist, `UnknownTemplateError` if the name doesn't match
 * a file in the type's `templates/`. The error's `availableTemplates`
 * carries the manifest so the caller (typically an agent that mis-typed)
 * can self-correct in one round trip.
 */
export function getWelcomeTemplate(
    installRoot: string,
    requestedType: string | null | undefined,
    name: string,
): WelcomeTemplate {
    const { project_type } = resolveProjectType(installRoot, requestedType);
    const typeDir = join(welcomeRoot(installRoot), project_type);
    const manifest = loadTemplateManifest(typeDir);
    const trimmedName = (name ?? "").trim();
    const entry = manifest.find((t) => t.name === trimmedName);
    if (!entry) {
        throw new UnknownTemplateError(
            trimmedName,
            project_type,
            manifest.map((t) => t.name),
        );
    }
    // Read the body using the file the manifest entry corresponds to —
    // `path_hint` is the basename inside `templates/`.
    const body = readFileSync(
        join(typeDir, "templates", entry.path_hint),
        "utf8",
    );
    return {
        ...entry,
        source_md: body,
    };
}
