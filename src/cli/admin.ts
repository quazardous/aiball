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


/** #2172 — above this many tickets, `project move` demands --yes. Low on
 *  purpose: the number exists to make an accidental fold impossible, not to
 *  measure anything. */
export const MOVE_CONFIRM_THRESHOLD = 10;

/**
 * #2172 — what `project move` should DO, decided without touching the network.
 *
 * Extracted so the refusals are testable: they live in a commander action
 * otherwise, and `die()` exits the process, so the only way to observe a
 * refusal would be to fork a shell. The rules are the interesting part —
 * especially "the target does not exist" pointing at `rename` instead of
 * silently creating it, which is the difference between the two commands.
 */
export type ProjectMoveVerdict =
    | { kind: "same" }
    | { kind: "no-source"; name: string }
    | { kind: "no-target"; name: string }
    | { kind: "empty" }
    | { kind: "needs-confirm"; count: number }
    | { kind: "go"; count: number };

export function planProjectMove(input: {
    source: string;
    target: string;
    known: readonly string[];
    ticketCount: number;
    yes: boolean;
}): ProjectMoveVerdict {
    if (input.source === input.target) return { kind: "same" };
    if (!input.known.includes(input.source)) return { kind: "no-source", name: input.source };
    if (!input.known.includes(input.target)) return { kind: "no-target", name: input.target };
    if (input.ticketCount === 0) return { kind: "empty" };
    if (input.ticketCount > MOVE_CONFIRM_THRESHOLD && !input.yes) {
        return { kind: "needs-confirm", count: input.ticketCount };
    }
    return { kind: "go", count: input.ticketCount };
}

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

    // #699 — rename a project (typo recovery). Cascades to every table
    // that stores the name. See db/projects.ts:renameProject for the audit
    // trail. Per david : delete + rename are CLI-only (removed from UI).
    project
        .command("rename <old> <new>")
        .description("Rename a project across all tables (typo recovery)")
        .action(async (oldName: string, newName: string, _opts, cmd) => {
            const client = buildClient(gOpts(cmd));
            const r = await client.renameProject(oldName, newName);
            out(r, gOpts(cmd), (x) => `project "${x.old_name}" renamed to "${x.new_name}" (tickets:${x.tickets} subs:${x.subscriptions} rules:${x.rules + x.automation_rules} consumers:${x.consumers})`);
        });

    // #2172 — fold a project INTO another one. `rename` already covers the
    // case where the destination does not exist, and refuses outright when it
    // does ("project X already exists") — that refusal is precisely the hole
    // this fills: merging into a project that already holds tickets.
    //
    // A loop over the same `POST /tickets/:id/move` the UI and the MCP tool
    // use, deliberately: it renumbers `display_seq` in the destination (there
    // is a UNIQUE (project, display_seq) index, so a bulk move that skipped
    // renumbering would collide), leaves the audit comment on each thread, and
    // invalidates what it must. None of that gets reimplemented here.
    //
    // The source project is left REGISTERED AND EMPTY rather than deleted:
    // there is no undo, and `project delete` already exists for whoever wants
    // the tidier end state.
    project
        .command("move <source> <target>")
        .description("Move every ticket of <source> into the EXISTING project <target> (the source is left empty, not deleted)")
        .option("--yes", `Required past ${MOVE_CONFIRM_THRESHOLD} tickets — this is a bulk write with no undo`)
        .action(async (source: string, target: string, opts: { yes?: boolean }, cmd) => {
            const client = buildClient(gOpts(cmd));
            // Cheap checks first, so a typo costs no query.
            const known = source === target ? [] : await client.listProjects() as string[];
            // `status: any` on purpose: a fold has to carry the pending and the
            // rejected too, or they are stranded in a project nobody looks at.
            const rows = known.includes(source) && known.includes(target)
                ? await client.listTickets({ project: source, status: "any" }) as { id: number }[]
                : [];
            const verdict = planProjectMove({
                source, target, known, ticketCount: rows.length, yes: opts.yes === true,
            });
            switch (verdict.kind) {
                case "same":
                    return die("project move: source and target are the same project");
                case "no-source":
                    return die(`project move: project "${verdict.name}" does not exist`);
                case "no-target":
                    return die(`project move: project "${verdict.name}" does not exist — to give "${source}" a new name, use: aiball project rename ${source} ${target}`);
                case "empty":
                    out({ moved: 0, source, target }, gOpts(cmd), () => `project "${source}" holds no ticket — nothing to move`);
                    return;
                case "needs-confirm":
                    return die(`project move: "${source}" holds ${verdict.count} tickets and there is no undo — pass --yes to go ahead`);
            }
            const moved: number[] = [];
            for (const r of rows) {
                try {
                    await client.moveTicket(r.id, target);
                    moved.push(r.id);
                } catch (e) {
                    // Report what DID move. A half-finished fold is recoverable
                    // — re-run it — but only if the operator is told where it
                    // stopped instead of being handed a bare stack trace.
                    die(`project move: stopped at ticket #${r.id} after moving ${moved.length}/${rows.length} — ${(e as Error).message}`);
                }
            }
            out({ moved: moved.length, source, target, ticket_ids: moved }, gOpts(cmd),
                (x) => `moved ${(x as { moved: number }).moved} ticket(s) from "${source}" into "${target}" — "${source}" is now empty (delete it with: aiball project delete ${source})`);
        });

    // #699 — delete a project + every row that references it. Moved out of
    // the UI per david : destructive, CLI-only.
    project
        .command("delete <name>")
        .description("Delete a project and every row that references it (DESTRUCTIVE — no undo)")
        .action(async (name: string, _opts, cmd) => {
            const client = buildClient(gOpts(cmd));
            const r = await client.deleteProject(name);
            out(r, gOpts(cmd), (x) => `project "${name}" deleted (${(x as { deleted_messages?: number }).deleted_messages ?? 0} messages)`);
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
