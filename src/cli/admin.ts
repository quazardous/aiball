/**
 * `aiball rule` + `aiball project` + top-level `feed-path` commands
 * (carved out of cli.ts in #B.213 phase 3.D on 2026-05-19). Behavior-
 * preserving move. Grouped together because they're all "administer
 * the daemon's metadata" verbs — distinct from ticket/auth/autopoll.
 *
 * Exposed entry point: `registerAdminCommands(program)`.
 */
import { basename } from "node:path";
import type { Command } from "commander";
import {
    buildClient,
    die,
    fmtProjectList,
    fmtRuleList,
    gOpts,
    out,
    userCwd,
} from "./_helpers.js";

export function registerAdminCommands(program: Command): void {
    // ---- rule -----------------------------------------------------------
    const rule = program.command("rule").description("Moderation rule engine");

    rule.command("list").action(async (_opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        out(await client.listRules(), gOpts(cmd), fmtRuleList);
    });

    rule
        .command("add")
        .requiredOption("--decision <decision>", "auto|review")
        .option("--project <project>")
        .option("--kind <kind>")
        .option("--by <agent>")
        .option("--note <note>")
        .action(async (opts, cmd) => {
            const client = buildClient(gOpts(cmd));
            const r = await client.addRule({
                decision: opts.decision as "auto" | "review",
                ...(opts.project ? { match_project: opts.project } : {}),
                ...(opts.kind ? { match_kind: opts.kind } : {}),
                ...(opts.by ? { match_by_agent: opts.by } : {}),
                ...(opts.note ? { note: opts.note } : {}),
            });
            out(r, gOpts(cmd), (v) => {
                const x = v as { id?: number; decision?: string };
                return `rule #${x.id ?? "?"} added (decision=${x.decision ?? "?"})`;
            });
        });

    rule
        .command("del <id>")
        .description("Delete a rule")
        .action(async (id: string, _opts, cmd) => {
            const client = buildClient(gOpts(cmd));
            out(await client.deleteRule(Number(id)), gOpts(cmd), () => `rule #${id} deleted`);
        });

    rule
        .command("enable <id>")
        .description("Enable a rule")
        .action(async (id: string, _opts, cmd) => {
            const client = buildClient(gOpts(cmd));
            out(await client.toggleRule(Number(id), true), gOpts(cmd), () => `rule #${id} enabled`);
        });

    rule
        .command("disable <id>")
        .description("Disable a rule")
        .action(async (id: string, _opts, cmd) => {
            const client = buildClient(gOpts(cmd));
            out(await client.toggleRule(Number(id), false), gOpts(cmd), () => `rule #${id} disabled`);
        });

    // ---- project --------------------------------------------------------
    const project = program.command("project").description("Project listing");
    project.command("list").action(async (_opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        out(await client.listProjects(), gOpts(cmd), fmtProjectList);
    });

    project
        .command("init [name]")
        .description("Register a project explicitly (defaults name to basename of cwd)")
        .option("--display-name <label>", "Human-friendly label shown in the UI")
        .option("--description <text>", "Project description")
        .action(async (
            nameArg: string | undefined,
            opts: { displayName?: string; description?: string },
            cmd,
        ) => {
            const client = buildClient(gOpts(cmd));
            const name = (nameArg ?? basename(userCwd())).trim();
            if (!name) die("could not derive project name from cwd; pass it explicitly");
            const row = await client.createProject(name, {
                display_name: opts.displayName,
                description: opts.description,
            });
            out(row, gOpts(cmd), (r) => `project "${r.name}" registered`);
        });

    // ---- feed-path (top-level) ------------------------------------------
    program
        .command("feed-path <project>")
        .description("Print the outbox feed path for tail -F")
        .action(async (proj: string, _opts, cmd) => {
            const client = buildClient(gOpts(cmd));
            const r = (await client.feedPath(proj)) as { path: string };
            process.stdout.write(r.path + "\n");
        });
}
