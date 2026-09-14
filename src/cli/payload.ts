/**
 * `aiball payload` — the ticket's payload zone (#2109).
 *
 * Subcommands: set, show, dump, revoke.
 *
 * The one non-obvious rule lives in `dump`: it refuses to write to stdout
 * unless you ask twice. A secret that is guarded in the database, filtered out
 * of every API response and kept out of URLs, and is then printed into the
 * terminal of the agent that asked for it, has been protected everywhere except
 * the one place it actually travelled. `--to <file>` is the normal path;
 * `--stdout` exists for a human at a keyboard who knows what their scrollback
 * is worth.
 */
import type { Command } from "commander";
import { readDepositFile, writeDumpFile } from "../payload-files.js";
import { buildClient, die, gOpts, jsonline, out } from "./_helpers.js";

/** `k=v` pairs from the command line, or a JSON object from a file. */
function collectPayload(opts: { set?: string[]; fromFile?: string }): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    if (opts.fromFile) {
        // #2454 — the parse error used to quote the file (Node's JSON errors
        // carry a snippet of the input): a malformed secret file echoed its own
        // secret into the terminal. The shared reader names the file, never it.
        try {
            Object.assign(payload, readDepositFile(opts.fromFile));
        } catch (e) {
            die((e as Error).message);
        }
    }
    for (const pair of opts.set ?? []) {
        const eq = pair.indexOf("=");
        if (eq <= 0) die(`--set expects key=value, got "${pair}"`);
        payload[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return payload;
}

function fmtView(v: unknown): string {
    const view = v as {
        ticket_id: number;
        keys?: string[];
        schema?: string[];
        payload?: Record<string, unknown>;
        access?: string;
        revoked_at?: string | null;
    };
    const lines = [`payload on #${view.ticket_id} — ${view.access ?? "?"}`];
    for (const [key, value] of Object.entries(view.payload ?? {})) {
        if (value && typeof value === "object" && (value as { secret?: boolean }).secret) {
            const preview = (value as { preview?: string | null }).preview;
            lines.push(`  ${key} : ${preview ? `${preview}…` : "(secret)"}`);
        } else {
            lines.push(`  ${key} : ${typeof value === "string" ? value : JSON.stringify(value)}`);
        }
    }
    if ((view.keys ?? []).length === 0) lines.push("  (no keys)");
    return lines.join("\n");
}

export function registerPayloadCommands(program: Command): void {
    const payload = program
        .command("payload")
        .description("Deposit / inspect / dump a ticket's payload zone");

    payload
        .command("set")
        .description("Deposit or replace a ticket's payload")
        .requiredOption("--id <id>", "Ticket id")
        .option(
            "--set <key=value...>",
            "Key/value pair. Beware: values land in your shell history — prefer --from-file for secrets",
        )
        .option("--from-file <path>", "JSON object of key -> value")
        .option(
            "--public <key...>",
            "Key that is NOT secret. Omit and everything is secret, which is the default on purpose",
        )
        .action(async (opts, cmd) => {
            const globalOpts = gOpts(cmd);
            const client = buildClient(globalOpts);
            const body = collectPayload(opts);
            if (Object.keys(body).length === 0) die("nothing to deposit — pass --set or --from-file");
            const res = await client.setTicketPayload(Number(opts.id), body, opts.public ?? []);
            out(res, globalOpts, fmtView);
        });

    payload
        .command("show")
        .description("Show the payload's shape: keys always, values only where public")
        .requiredOption("--id <id>", "Ticket id")
        .action(async (opts, cmd) => {
            const globalOpts = gOpts(cmd);
            const client = buildClient(globalOpts);
            const res = await client.ticketPayload(Number(opts.id));
            out(res, globalOpts, fmtView);
        });

    payload
        .command("dump")
        .description("Retrieve the payload's VALUES — the deliberate gesture")
        .requiredOption("--id <id>", "Ticket id")
        .option("--to <path>", "Write the values here, mode 0600 (the normal path)")
        .option("--format <format>", "json | env (with --to; env merges into an existing file)", "json")
        .option("--stdout", "Print to stdout instead. Your terminal keeps it — say it on purpose")
        .action(async (opts, cmd) => {
            const globalOpts = gOpts(cmd);
            if (!opts.to && !opts.stdout) {
                die(
                    "refusing to print a secret you did not ask for: pass --to <file>, or --stdout if you really mean the terminal",
                );
            }
            if (opts.format !== "json" && opts.format !== "env") die("--format expects json or env");
            const client = buildClient(globalOpts);
            const res = (await client.dumpTicketPayload(Number(opts.id))) as {
                payload: Record<string, unknown>;
            };
            if (opts.stdout) {
                jsonline(res);
                return;
            }
            // #2454 — an env dump merges into an existing file instead of
            // rewriting it: the other keys of a service's .env stay put.
            const written = writeDumpFile(opts.to, res.payload, opts.format);
            process.stderr.write(
                `${written.merged ? "merged" : "wrote"} ${written.keys.length} key(s) ${written.merged ? "into" : "to"} ${opts.to} (mode 0600)\n`,
            );
        });

    payload
        .command("revoke")
        .description("Destroy the values, keep the trace that they existed")
        .requiredOption("--id <id>", "Ticket id")
        .action(async (opts, cmd) => {
            const globalOpts = gOpts(cmd);
            const client = buildClient(globalOpts);
            const res = await client.revokeTicketPayload(Number(opts.id));
            out(res, globalOpts, fmtView);
        });
}
