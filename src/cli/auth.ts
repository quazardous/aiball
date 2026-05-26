/**
 * `aiball auth` command group (carved out of cli.ts in #B.213 phase
 * 3.A on 2026-05-19). Behavior-preserving move.
 *
 * Subcommands:
 *   - `init`    — first-time setup, mints install token + prints URL
 *   - `reinit`  — force a fresh install token (password reset / 2nd human)
 *   - `issue`   — mint a long-lived agent or auth token
 *   - `list`    — list every active token
 *   - `revoke`  — delete a token by full string or unique prefix
 *
 * Exposed entry point: `registerAuthCommands(program)`. cli.ts calls
 * this once during command-tree construction. `die` + `URL` are
 * duplicated as tiny inlined helpers — same rationale as
 * src/api/_helpers.ts pattern (3-5 lines each).
 */
import { hostname } from "node:os";
import type { Command } from "commander";
import {
    anyHumanCredentials,
    deleteToken,
    getConsumer,
    issueToken,
    listTokens,
    upsertConsumer,
} from "../db.js";

const URL = process.env.AIBALL_URL ?? "http://127.0.0.1:7777";

function die(msg: string): never {
    process.stderr.write(`aiball: ${msg}\n`);
    process.exit(1);
}

export function registerAuthCommands(program: Command): void {
    const auth = program.command("auth").description("Bootstrap + token management");

    auth.command("init")
        .description(
            "First-time setup. Mints an install token + prints the URL to open in a browser. Refuses if humans are already configured (use `auth reinit` to force).",
        )
        .option("--port <port>", "Daemon port for the printed URL", String(URL.match(/:(\d+)/)?.[1] ?? "7777"))
        .option("--host <host>", "Hostname for the printed URL", "127.0.0.1")
        .action((opts: { port: string; host: string }) => {
            if (anyHumanCredentials()) {
                die("auth init: already initialized. Use `aiball auth reinit` to force a fresh install token, or `aiball auth issue` to mint an agent token for a CLI/MCP client.");
            }
            const existing = listTokens({ kind: "install" });
            const t = existing.length > 0 ? existing[0] : issueToken({
                kind: "install",
                label: "first-time init",
                expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
            });
            const setupUrl = `http://${opts.host}:${opts.port}/setup?t=${t.token}`;
            process.stdout.write([
                `aiball is ready for setup.`,
                ``,
                `  Open: ${setupUrl}`,
                ``,
                `Choose your login + password in the web form. The install token`,
                `is one-shot and expires after 24h.`,
                ``,
            ].join("\n"));
        });

    auth.command("reinit")
        .description(
            "Force a fresh install token even if humans are already configured. Useful for password reset or onboarding a second human.",
        )
        .option("--port <port>", "Daemon port for the printed URL", String(URL.match(/:(\d+)/)?.[1] ?? "7777"))
        .option("--host <host>", "Hostname for the printed URL", "127.0.0.1")
        .action((opts: { port: string; host: string }) => {
            const t = issueToken({
                kind: "install",
                label: "reinit",
                expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
            });
            const setupUrl = `http://${opts.host}:${opts.port}/setup?t=${t.token}`;
            process.stdout.write([
                `Fresh install token issued.`,
                ``,
                `  Open: ${setupUrl}`,
                ``,
                `One-shot, expires in 24h. Existing humans / sessions are untouched.`,
                ``,
            ].join("\n"));
        });

    auth.command("issue")
        .description("Mint a long-lived agent token bound to a consumer (or a --node service token for #394 proxy mode). Used for CLI / MCP / sandbox / proxy clients.")
        .option("--consumer <id>", "consumer_id to bind the token to (created on the fly if it doesn't exist). Required unless --node.")
        .option("--label <label>", "Human-readable label (e.g. 'laptop cli', 'sandbox-1', 'B proxy node')")
        .option(
            "--kind <kind>",
            "Token kind: 'agent' (default) or 'auth' (web-style, normally minted by /login)",
            "agent",
        )
        .option(
            "--node",
            "Mint a NODE token instead — a trusted-proxy SERVICE token (#394), NOT bound to a consumer. It lets a proxy node assert relayed identities via x-aiball-consumer. Put it in the node's `proxy.token`.",
        )
        .action((opts: { consumer?: string; label?: string; kind: string; node?: boolean }) => {
            // #394 volet C: a node token is a service credential for the proxy
            // node — no consumer, kind 'node'. The daemon then trusts the
            // forwarded x-aiball-consumer (X-Forwarded-For style).
            if (opts.node) {
                // #463 — default label to the host's machine name so a fresh
                // node is immediately recognizable in the Nodes panel without
                // the operator passing --label. The label is also
                // node-overridable at runtime via `node.label` in the proxy
                // node's own config (see src/proxy.ts) — the node side owns
                // the label and pushes any change on each request via the
                // `x-aiball-node-label` header.
                const t = issueToken({
                    consumer_id: null,
                    kind: "node",
                    label: opts.label ?? hostname(),
                });
                process.stdout.write([
                    `NODE token issued (trusted-proxy service token, no consumer):`,
                    ``,
                    `  ${t.token}`,
                    ``,
                    `Put it in the proxy node's global config (machine B):`,
                    `  proxy:`,
                    `    url: <this daemon's URL>`,
                    `    token: ${t.token}`,
                    ``,
                    `Or: aiball proxy init --url <A-url> --token ${t.token}`,
                    ``,
                    `⚠ SECURITY: this token is impersonation-capable — it can assert ANY`,
                    `  consumer (it is NOT scoped). Treat it like a master credential:`,
                    `  private network (tailnet/LAN) only, never expose it publicly, never`,
                    `  commit it. For per-consumer proof instead, use direct mode (#390 — a`,
                    `  per-consumer agent token). See docs/REMOTE.md § Trust model.`,
                    ``,
                ].join("\n"));
                return;
            }
            if (!opts.consumer) {
                die("auth issue: --consumer <id> is required (or pass --node for a proxy service token)");
            }
            if (opts.kind !== "agent" && opts.kind !== "auth") {
                die(`auth issue: --kind must be 'agent' or 'auth' (got '${opts.kind}')`);
            }
            // #390 (david kwca43): create the consumer on the fly when it doesn't
            // exist yet. A remote agent has no other way to bootstrap its identity
            // — it can't "post first" to auto-register without already having a
            // token. Idempotent: an existing consumer is left untouched.
            const existed = getConsumer(opts.consumer) !== null;
            if (!existed) upsertConsumer({ consumer_id: opts.consumer, kind: "agent" });
            const t = issueToken({
                consumer_id: opts.consumer,
                kind: opts.kind as "agent" | "auth",
                label: opts.label ?? null,
            });
            process.stdout.write([
                ...(existed ? [] : [`Created consumer '${opts.consumer}' (agent).`, ``]),
                `Token issued for ${opts.consumer}:`,
                ``,
                `  ${t.token}`,
                ``,
                `Use it as: export AIBALL_TOKEN=${t.token}`,
                `(or pass Authorization: Bearer ${t.token} on each API call)`,
                ``,
            ].join("\n"));
        });

    auth.command("list")
        .description("List every active token (install + auth + agent)")
        .action(() => {
            const rows = listTokens();
            if (rows.length === 0) {
                process.stdout.write("(no tokens)\n");
                return;
            }
            for (const t of rows) {
                const exp = t.expires_at ? ` expires=${t.expires_at}` : "";
                const last = t.last_used_at ? ` last=${t.last_used_at}` : " never used";
                const lbl = t.label ? ` "${t.label}"` : "";
                process.stdout.write(
                    `${t.kind.padEnd(7)}  ${t.consumer_id ?? "(no consumer)"}  ${t.token}${lbl}${last}${exp}\n`,
                );
            }
        });

    auth.command("revoke <token-or-prefix>")
        .description("Delete a token by its full string (or a unique prefix, e.g. 'aiball-abc1234')")
        .action((needle: string) => {
            const rows = listTokens();
            const matches = rows.filter((t) => t.token === needle || t.token.startsWith(needle));
            if (matches.length === 0) die(`auth revoke: no token matching '${needle}'`);
            if (matches.length > 1) {
                die(
                    `auth revoke: prefix '${needle}' matches ${matches.length} tokens — be more specific:\n` +
                        matches.map((t) => `  ${t.token} (${t.kind})`).join("\n"),
                );
            }
            deleteToken(matches[0].token);
            process.stdout.write(`revoked ${matches[0].token}\n`);
        });
}
