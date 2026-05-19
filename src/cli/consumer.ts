/**
 * Consumer-facing commands: identity (`whoami`), subscriptions
 * (`subscribe` / `unsubscribe` / `subs`), and ping draining (`unread`
 * / `pings-count` / `mark-read`). Carved out of cli.ts in #B.213
 * phase 3.G on 2026-05-19. Behavior-preserving move.
 *
 * Exposed entry point: `registerConsumerCommands(program)`.
 */
import type { Command } from "commander";
import {
    buildClient,
    die,
    fmtSubscribe,
    fmtSubsList,
    fmtUnread,
    fmtWhoami,
    gOpts,
    out,
    userCwd,
    withProject,
} from "./_helpers.js";

export function registerConsumerCommands(program: Command): void {
    program
        .command("whoami")
        .description("Print the consumer_id used here (identity only — for daemon health use `aiball status`, for full config audit use `aiball check`)")
        .action(async (_opts, cmd) => {
            const globalOpts = gOpts(cmd);
            const client = buildClient(globalOpts);
            const { loadConfig } = await import("../autopoll/config.js");
            const cfg = loadConfig(userCwd());
            let source: string;
            if (globalOpts.human) source = "--human flag ($AIBALL_HUMAN)";
            else if (process.env.AIBALL_AGENT) source = "$AIBALL_AGENT env";
            else if (cfg.consumer.agent_source === "aiball.yaml") source = ".aiball.yaml consumer.agent";
            else if (cfg.consumer.agent_source === "mcp.json") source = ".mcp.json env (DEPRECATED)";
            else source = "<basename(cwd)>-claude (default)";
            const payload = {
                consumer_id: client.agentId,
                cwd: userCwd(),
                source,
                human: globalOpts.human === true,
                default_project: client.defaultProject,
            };
            out(payload, globalOpts, fmtWhoami);
        });

    program
        .command("subscribe <project>")
        .description("Subscribe the current consumer to a project")
        .option("--catchup", "Start with the project's existing backlog")
        .option("--role <role>", "owner|follower")
        .action(async (proj: string, opts, cmd) => {
            const client = buildClient(gOpts(cmd));
            const project = client.resolveProject(proj);
            let sub: unknown;
            try {
                sub = await client.subscribe(
                    project,
                    opts.catchup === true,
                    opts.role as "owner" | "follower" | undefined,
                );
            } catch {
                sub = { warning: "daemon unreachable, subscription not registered" };
            }
            const fp = (await client.feedPath(project)) as { path: string };
            const payload = {
                consumer_id: client.agentId,
                project,
                feed_path: fp.path,
                subscription: sub,
                monitor_command: `tail -F -n 0 ${fp.path}`,
            };
            out(payload, gOpts(cmd), fmtSubscribe);
        });

    program
        .command("unsubscribe <project>")
        .description("Unsubscribe the current consumer from a project")
        .action(async (proj: string, _opts, cmd) => {
            const client = buildClient(gOpts(cmd));
            const project = client.resolveProject(proj);
            await client.unsubscribe(project);
            out(
                { unsubscribed: true, consumer_id: client.agentId, project },
                gOpts(cmd),
                (v) => `unsubscribed ${v.consumer_id} from ${v.project}`,
            );
        });

    program
        .command("subs")
        .description("List this consumer's subscriptions")
        .action(async (_opts, cmd) => {
            const client = buildClient(gOpts(cmd));
            out(await client.mySubs(), gOpts(cmd), fmtSubsList);
        });

    program
        .command("unread")
        .description("Pull unseen messages for the current consumer")
        .option("--project <project>")
        .option("--limit <n>", "Max rows to return", "100")
        .action(async (opts, cmd) => {
            const client = buildClient(gOpts(cmd));
            const project = withProject(client, opts.project);
            out(await client.unread(project, Number(opts.limit)), gOpts(cmd), fmtUnread);
        });

    program
        .command("pings-count")
        .description(
            "Print the count of unread pings for the current consumer. " +
            "Exits 0 when count > 0 (= there's something to drain), exit 1 " +
            "when count === 0. Useful as a shell check in pipelines like " +
            "claude-loop's default check-cmd (#B.63).",
        )
        .option("-q, --quiet", "Suppress stdout (just use the exit code)")
        .action(async (opts, cmd) => {
            const client = buildClient(gOpts(cmd));
            const r = (await client.pingsCount()) as { consumer_id: string; unread: number };
            const n = r.unread ?? 0;
            if (!opts.quiet) process.stdout.write(`${n}\n`);
            process.exit(n > 0 ? 0 : 1);
        });

    program
        .command("mark-read")
        .description("Bulk mark project messages as seen")
        .requiredOption("--project <project>", "Project to ack")
        .option("--up-to <id>", "Mark seen up to (and including) this message id")
        .option("--all", "Mark all current messages as seen")
        .action(async (opts, cmd) => {
            const client = buildClient(gOpts(cmd));
            const project = client.resolveProject(opts.project);
            if (!opts.all && !opts.upTo) {
                die("mark-read: provide --up-to N or --all");
            }
            const res = await client.markReadProject({
                project,
                ...(opts.all ? { all: true } : {}),
                ...(opts.upTo ? { upToId: Number(opts.upTo) } : {}),
            });
            out(res, gOpts(cmd), (v) => {
                const r = v as { acked?: number; consumer_id?: string };
                const n = r.acked ?? 0;
                return `marked ${n} message${n === 1 ? "" : "s"} read in ${project}${r.consumer_id ? ` (as ${r.consumer_id})` : ""}`;
            });
        });
}
