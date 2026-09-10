/**
 * Consumer-facing commands: identity (`whoami`), subscriptions
 * (`subscribe` / `unsubscribe` / `subs`), and ping draining (`unread`
 * / `pings-count` / `mark-read`). Carved out of cli.ts in #B.213
 * phase 3.G on 2026-05-19. Behavior-preserving move.
 *
 * Exposed entry point: `registerConsumerCommands(program)`.
 */
import type { Command } from "commander";
import { ensureConsumerRecord } from "../claude-loop/agent-type.js";
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

/**
 * #2180 — what `aiball agent set` should send, as a pure verdict so a test sees
 * every refusal (`die` exits). Only the human-set fields of an agent record;
 * the daemon still decides who may set them.
 */
export type AgentSetVerdict =
    | { kind: "go"; patch: { agent_type?: "coder" | "cto"; can_claim?: boolean } }
    | { kind: "bad"; message: string };
export function planAgentSet(opts: { type?: string; canClaim?: string }): AgentSetVerdict {
    const patch: { agent_type?: "coder" | "cto"; can_claim?: boolean } = {};
    if (opts.type !== undefined) {
        if (opts.type !== "coder" && opts.type !== "cto") return { kind: "bad", message: `--type must be coder or cto, got "${opts.type}"` };
        patch.agent_type = opts.type;
    }
    if (opts.canClaim !== undefined) {
        if (opts.canClaim !== "true" && opts.canClaim !== "false") return { kind: "bad", message: `--can-claim must be true or false, got "${opts.canClaim}"` };
        patch.can_claim = opts.canClaim === "true";
    }
    if (Object.keys(patch).length === 0) return { kind: "bad", message: "nothing to set: pass --type and/or --can-claim" };
    return { kind: "go", patch };
}

export function registerConsumerCommands(program: Command): void {
    // #2180 — the human-set fields of an agent record, from the terminal. Until
    // now only the UI could touch them. The daemon refuses them from an agent,
    // so this is run with --human.
    const agent = program.command("agent").description("Agent records: the fields a human sets (type, can-claim)");
    agent
        .command("set <id>")
        .description("Set an agent's type (coder | cto) and/or can-claim — human only (run with --human)")
        .option("--type <type>", "coder | cto")
        .option("--can-claim <bool>", "true | false")
        .action(async (id: string, opts: { type?: string; canClaim?: string }, cmd) => {
            const verdict = planAgentSet(opts);
            if (verdict.kind === "bad") die(verdict.message);
            const client = buildClient(gOpts(cmd));
            // Create the record only if there is none, so an agent can be typed
            // before it ever ran. Never re-post an existing one: POST resets every
            // field it is not sent (display name, note, and re-enables a disabled
            // agent).
            await ensureConsumerRecord(client, id);
            const r = (await client.patchConsumer(id, verdict.patch)) as { agent_type?: string; can_claim?: boolean };
            out(r, gOpts(cmd), (x) => `agent ${id}: type ${x.agent_type ?? "?"}, can-claim ${x.can_claim ?? "?"}\n  the MCP server reads the type at start-up: restart the agent's loop for it to apply`);
        });

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
        .description("Bulk mark messages as seen (or --delete) — a project, or --all-projects. #1185: --consumer / --delete are local-trust operator actions.")
        .option("--project <project>", "Project to ack")
        .option("--up-to <id>", "Mark seen up to (and including) this message id")
        .option("--all", "Mark all current messages as seen (needs --project)")
        .option("--all-projects", "Drain the consumer's pings across EVERY project (firehose prune)")
        .option("--delete", "Hard-DELETE the ping rows instead of marking them seen (local-trust only)")
        .option("--consumer <id>", "Target ANOTHER consumer's backlog (operator, local-trust only). Default: self.")
        .action(async (opts, cmd) => {
            const client = buildClient(gOpts(cmd));
            const allProjects = !!opts.allProjects;
            const del = !!opts.delete;
            if (!allProjects && !opts.project) {
                die("mark-read: provide --project <p> or --all-projects");
            }
            if (!allProjects && !opts.all && !opts.upTo && !del) {
                die("mark-read: with --project, provide --up-to N, --all, or --delete");
            }
            const project = opts.project ? client.resolveProject(opts.project) : undefined;
            const res = await client.markReadProject({
                ...(project ? { project } : {}),
                ...(allProjects ? { allProjects: true } : {}),
                ...(opts.all ? { all: true } : {}),
                ...(opts.upTo ? { upToId: Number(opts.upTo) } : {}),
                ...(del ? { del: true } : {}),
                ...(opts.consumer ? { consumer: String(opts.consumer) } : {}),
            });
            out(res, gOpts(cmd), (v) => {
                const r = v as { acked?: number; updated?: number; affected?: number; deleted?: boolean; consumer_id?: string };
                const n = r.affected ?? r.updated ?? r.acked ?? 0;
                const verb = r.deleted ? "deleted" : "marked read";
                const where = allProjects ? "all projects" : project;
                return `${verb} ${n} ping${n === 1 ? "" : "s"} in ${where}${r.consumer_id ? ` (for ${r.consumer_id})` : ""}`;
            });
        });
}
