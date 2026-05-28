/**
 * #565 — `welcome` MCP tool. Returns the onboarding kit (master tone
 * doc + rules + templates) for the current project's `project_type`.
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
 *     disponibles.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText } from "./_helpers.js";
import { loadConfig } from "../autopoll/config.js";
import { installRoot } from "../claude-loop/state.js";
import {
    buildWelcomeKit,
    availableTypes,
    DEFAULT_PROJECT_TYPE,
    UnknownProjectTypeError,
} from "../welcome.js";

export function registerWelcomeTools(server: McpServer): void {
    server.registerTool(
        "welcome",
        {
            description:
                "Onboarding kit. Returns the master `WELCOME.md` tone doc + scaffolding templates shipped by aiball for the project's declared `project_type` (read from `.aiball.yaml`, default `public`). User-triggered : the human asks the agent to call it ; do NOT auto-invoke on engage / session-start. Read `welcome_md` FIRST — it carries the type's non-negotiables (versioning, secrets out of repo, code in English …) + the spirit to operate in for the whole session ; absorb it into persistent memory as project-wide invariants. Then, for each template, check if the equivalent file exists in the project ; if missing, read the template (drop its `<!-- intent: … -->` header — it's for you, not the public reader), adapt the body, and create the file. If present, NEVER overwrite — suggest a diff to the user. Valid `project_type` values are filesystem-discovered (folders under `<install>/welcome/<type>/` carrying a `WELCOME.md`) ; add a type = drop a sibling folder + WELCOME.md, no code change. Errors out explicitly if the configured type isn't valid, listing the available ones.",
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
            // Resolution chain (per david `87dp6p` + `yvth6d`) :
            //   1. explicit MCP arg (debug / preview)
            //   2. `.aiball.yaml project_type:`
            //   3. fail-safe default `public`
            // loadConfig is cwd-anchored ; the MCP server runs in the
            // agent's project cwd, so the resolved config IS the project's.
            const cfg = loadConfig(process.cwd());
            const requested = project_type ?? cfg.project_type ?? DEFAULT_PROJECT_TYPE;
            try {
                const kit = buildWelcomeKit(root, requested);
                return asText({
                    ...kit,
                    // Diagnostics : where the values came from. Useful when
                    // the agent / human is debugging "why did welcome give
                    // me this kit" without re-reading the yaml.
                    _source: {
                        project_type_requested: requested,
                        project_type_from_arg: project_type ?? null,
                        project_type_from_yaml: cfg.project_type,
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
}
