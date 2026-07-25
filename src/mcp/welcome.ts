/**
 * #565 — `welcome` + `welcome_template` MCP tools.
 *
 * V1.2 (david `zrdffz`) — split en deux tools pour le token-efficiency :
 *   - `welcome()` returns the kit MANIFEST (project_type, available_types,
 *     `welcome_md` tone doc, `templates: [{name, path_hint}]`). Lightweight.
 *   - `welcome_template({name})` fetches the body for ONE template at a
 *     time. The agent pays only for the templates it actually applies
 *     (typically 1-2 out of N).
 *
 * User-triggered: the human asks the agent "call the welcome MCP".
 * Not auto-invoked on engage/session-start — sinon coût de tokens à
 * chaque session pour un kit qui n'évolue pas souvent.
 *
 * Resolution:
 *   - `project_type` lu dans `.aiball.yaml` (per-project) ; absent →
 *     défaut `public` (fail-safe : si l'utilisateur oublie, on
 *     applique les règles strictes plutôt que rien).
 *   - Valid types = filesystem-discovered (= `ls <install>/welcome/`).
 *     Ajouter un type = créer un dossier `welcome/<name>/` avec un
 *     `WELCOME.md`, zéro changement code.
 *   - Type unknown → erreur explicite avec la liste des types
 *     disponibles. Pareil pour un nom de template inconnu.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText } from "./_helpers.js";
import { loadConfig } from "../autopoll/config.js";
import { installRoot } from "../claude-loop/state.js";
import {
    availableTypes,
    buildWelcomeKit,
    DEFAULT_PROJECT_TYPE,
    getWelcomeTemplate,
    UnknownProjectTypeError,
    UnknownTemplateError,
} from "../welcome.js";

/** Resolve the requested `project_type` from (MCP arg → .aiball.yaml →
 *  fail-safe default). Shared by both tools so they apply the same
 *  precedence + the same `_source` diagnostic surface. */
function resolveType(arg: string | undefined): {
    requested: string;
    fromArg: string | null;
    fromYaml: string | null;
} {
    // #591 — bin/aiball-mcp cd's to the install root before exec, so
    // process.cwd() inside this subprocess is the AIBALL install dir, NOT
    // the project the agent was launched in. AIBALL_CWD preserves the
    // caller's PWD (same pattern as bin/aiball, src/mcp/_helpers.ts,
    // src/client.ts). Without this, loadConfig walks up from the install
    // root and never sees the per-project .aiball.yaml.
    const cfg = loadConfig(process.env.AIBALL_CWD ?? process.cwd());
    return {
        requested: arg ?? cfg.project_type ?? DEFAULT_PROJECT_TYPE,
        fromArg: arg ?? null,
        fromYaml: cfg.project_type,
    };
}

export function registerWelcomeTools(server: McpServer): void {
    server.registerTool(
        "welcome",
        {
            description:
                "Onboarding kit MANIFEST. Returns the master `WELCOME.md` tone doc + a lightweight list of available scaffolding templates (`{name, path_hint}`, NO bodies) for the project's declared `project_type` (read from `.aiball.yaml`, default `public`). User-triggered : the human asks the agent to call it ; do NOT auto-invoke on engage / session-start. Read `welcome_md` FIRST — it carries the type's non-negotiables (versioning, secrets out of repo, code in English …) + the spirit to operate in for the whole session ; absorb it into persistent memory as project-wide invariants. Then, for each template you actually want to apply, fetch its body via `welcome_template({name: \"<name>\"})` — the split keeps `welcome` cheap and only pays the bodies you really use. Templates already present in the project should NOT be overwritten — read the existing file first, suggest a diff to the user if outdated. Valid `project_type` values are filesystem-discovered (folders under `<install>/welcome/<type>/` carrying a `WELCOME.md`) ; add a type = drop a sibling folder + WELCOME.md, no code change. Errors out explicitly if the configured type isn't valid, listing the available ones.",
            inputSchema: {
                project_type: z
                    .string()
                    .optional()
                    .describe(
                        "Override the `project_type` from `.aiball.yaml`. Rarely needed — the tool reads the project context by default. Provide it to inspect another type's kit (e.g. `welcome({project_type:'private'})` to preview what `private` ships before adopting it).",
                    ),
            },
        },
        async ({ project_type }) => {
            const root = installRoot();
            const { requested, fromArg, fromYaml } = resolveType(project_type);
            try {
                const kit = buildWelcomeKit(root, requested);
                return asText({
                    ...kit,
                    // Diagnostics : where the values came from. Useful when
                    // the agent / human is debugging "why did welcome give
                    // me this kit" without re-reading the yaml.
                    _source: {
                        project_type_requested: requested,
                        project_type_from_arg: fromArg,
                        project_type_from_yaml: fromYaml,
                        project_type_default: DEFAULT_PROJECT_TYPE,
                        install_root: root,
                    },
                });
            } catch (err) {
                if (err instanceof UnknownProjectTypeError) {
                    // Error returned as content with `isError:true` so the
                    // MCP client surfaces the message + the discovery list
                    // (not a thrown exception that erases the available
                    // types) — david `yvth6d` "erreur explicite (available:
                    // [public, private])".
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify(
                                    {
                                        error: (err as Error).message,
                                        available_types: availableTypes(root),
                                    },
                                    null,
                                    2,
                                ),
                            },
                        ],
                    };
                }
                throw err;
            }
        },
    );

    server.registerTool(
        "welcome_template",
        {
            description:
                "Fetch the body of a single scaffolding template by name (V1.2 token-efficiency split with `welcome`). Use this AFTER `welcome()` has returned the manifest — pick a `name` from `templates[].name`, call here to get `source_md`. The body starts with an HTML comment block (`<!-- intent: … -->`) that explains how to adapt the template ; DROP that comment before writing the final file (it's for the agent, not the public reader). `path_hint` indicates where the file conventionally lives in a project (root unless otherwise specified). NEVER overwrite an existing file with the same path — if present, read it first and suggest a diff to the user. Returns an error with the available template names if the name isn't recognised for the type.",
            inputSchema: {
                name: z
                    .string()
                    .min(1)
                    .describe(
                        "Template slug (e.g. `\"CHANGELOG\"`, `\"README\"`, `\"LICENSE\"`) — pick from the `welcome()` manifest's `templates[].name`. Filename extension is implicit (the on-disk template is `<name>.<ext>` ; `path_hint` from the manifest carries the basename).",
                    ),
                project_type: z
                    .string()
                    .optional()
                    .describe(
                        "Override the `project_type` from `.aiball.yaml`. Should match the type used in the `welcome()` call that surfaced this template name — otherwise you may hit an `unknown template` error if the type doesn't ship that template.",
                    ),
            },
        },
        async ({ name, project_type }) => {
            const root = installRoot();
            const { requested } = resolveType(project_type);
            try {
                const tpl = getWelcomeTemplate(root, requested, name);
                return asText(tpl);
            } catch (err) {
                if (err instanceof UnknownProjectTypeError) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify(
                                    {
                                        error: (err as Error).message,
                                        available_types: availableTypes(root),
                                    },
                                    null,
                                    2,
                                ),
                            },
                        ],
                    };
                }
                if (err instanceof UnknownTemplateError) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify(
                                    {
                                        error: (err as Error).message,
                                        available_templates: (err as UnknownTemplateError).availableTemplates,
                                    },
                                    null,
                                    2,
                                ),
                            },
                        ],
                    };
                }
                throw err;
            }
        },
    );
}
