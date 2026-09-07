#!/usr/bin/env tsx
/**
 * aiball CLI — replaces the legacy bash bin/aiball entry. Uses commander
 * for dispatch and shares the same HTTP/spool semantics with the rest of
 * the codebase through {@link AiballClient}.
 *
 * Global flag --human / -H swaps the active consumer to $AIBALL_HUMAN
 * (default "human"), so a single CLI invocation can play either side.
 */
import { existsSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { AiballClient } from "./client.js";
import { AIBALL_VERSION } from "./version.js";
import { checkPrereqs, checkShims } from "./sysdeps.js";
import { restartViaSupervisor, supervisorHint } from "./supervisor-restart.js";
import { registerSandboxCommands } from "./sandbox/cli.js";
import { registerAuthCommands } from "./cli/auth.js";
import { registerPayloadCommands } from "./cli/payload.js";
import { registerTicketCommands } from "./cli/ticket.js";
import { registerAdminCommands } from "./cli/admin.js";
import { registerAutopollCommands } from "./cli/autopoll.js";
import { registerBootstrapCommands } from "./cli/bootstrap.js";
import { registerConsumerCommands } from "./cli/consumer.js";
import { registerInstallCommands } from "./cli/install.js";
import { registerProviderCommands } from "./cli/providers.js";
import { providersStatus } from "./providers.js";
import { loadProxy } from "./proxy.js";
import {
    URL,
    die,
    userCwd,
    jsonline,
    out,
    fmtStatus,
    buildClient,
    gOpts,
} from "./cli/_helpers.js";

// =====================================================================
// Program + global options
// =====================================================================

const program = new Command();
program
    .name("aiball")
    .description("CLI for the inter-agent BAL daemon")
    .version(AIBALL_VERSION, "-v, --version", "print the aiball version and exit")
    .option(
        "-H, --human",
        "Act as the human moderator (consumer_id and default --by become $AIBALL_HUMAN, default \"human\")",
    )
    .option(
        "-J, --json",
        "Machine-readable JSON output (default is human-readable text). Must be placed before the subcommand, e.g. `aiball --json status`.",
    );

// =====================================================================
// ticket subcommands → ./cli/ticket.ts (#B.213 phase 3.C).
// rule + project + feed-path → ./cli/admin.ts (#B.213 phase 3.D).
// autopoll subcommands → ./cli/autopoll.ts (#B.213 phase 3.E).
// =====================================================================
registerTicketCommands(program);
registerPayloadCommands(program);
registerAdminCommands(program);
registerAutopollCommands(program);
registerConsumerCommands(program);
registerProviderCommands(program);
registerInstallCommands(program);

// =====================================================================
// status / drain
// =====================================================================

function aiballHome(): string {
    return (
        process.env.AIBALL_HOME ??
        join(process.env.HOME ?? "/tmp", ".local", "share", "aiball")
    );
}

program
    .command("status")
    .description("Daemon liveness + spool/DB sizes (use `aiball check` for full project config audit, `aiball whoami` for identity only)")
    .action(async (_opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        let up = false;
        let daemonInfo: unknown = null;
        try {
            daemonInfo = await client.health();
            up = true;
        } catch {
            /* daemon down */
        }
        const home = aiballHome();
        const spoolDir = join(home, "spool");
        let spoolCount = 0;
        if (existsSync(spoolDir)) {
            spoolCount = readdirSync(spoolDir).filter((f) => f.endsWith(".json")).length;
        }
        // #389: the failed/ subdir is a graveyard of rejected writes (each a
        // message that never landed). It was invisible here — surface it so a
        // growing backlog of lost comments is noticed instead of silent.
        const failedDir = join(spoolDir, "failed");
        let spoolFailed = 0;
        if (existsSync(failedDir)) {
            spoolFailed = readdirSync(failedDir).filter((f) => f.endsWith(".json")).length;
        }
        const dbPath = join(home, "aiball.db");
        let dbSize = 0;
        if (existsSync(dbPath)) {
            try {
                dbSize = statSync(dbPath).size;
            } catch {
                /* ignore */
            }
        }
        // #380: surface remote-access providers (configured + live serve
        // status) so `aiball status` answers "is my tailscale proxy up?".
        const providers = providersStatus();
        // #394: is THIS daemon a proxy NODE (relaying to a remote aiball)? The
        // local `proxy:` config gives the upstream + strict flag and works even
        // when the daemon is down; the never-relayed `/api/node` probe is the
        // runtime truth, so it wins over a config that was edited but not yet
        // applied (proxy mode is read once at boot — needs a hard restart).
        const proxyCfg = loadProxy();
        let proxyNode: { upstream: string; strict: boolean } | null = proxyCfg
            ? { upstream: proxyCfg.url, strict: proxyCfg.strict ?? false }
            : null;
        try {
            const n = await client.node();
            proxyNode = n.proxy && n.upstream
                ? { upstream: n.upstream, strict: proxyCfg?.strict ?? false }
                : null;
        } catch {
            /* daemon down / pre-#394 daemon → keep the config-derived value */
        }
        const payload = {
            daemon_up: up,
            url: URL,
            paths: {
                home,
                db: dbPath,
                db_size: dbSize,
                outbox_dir: join(home, "outbox"),
                spool_dir: spoolDir,
            },
            spool_pending: spoolCount,
            spool_failed: spoolFailed,
            providers,
            proxy_node: proxyNode,
            daemon: daemonInfo,
        };
        out(payload, gOpts(cmd), fmtStatus);
    });

program
    .command("download <ref>")
    .description(
        "Download a ticket's attached upload (#390). <ref> is the `/uploads/<sha>.<ext>` " +
            "reference (or bare `<sha>.<ext>`) from a ticket's attachments[]. Fetches it over " +
            "the configured transport (UDS locally, TCP+token for a remote daemon), writes it " +
            "locally and prints the path — so a REMOTE loop can read images it can't open as file://.",
    )
    .option("--out <path>", "Output file path (default: $TMPDIR/aiball-<sha>.<ext>)")
    .action(async (ref: string, opts: { out?: string }, cmd) => {
        // Accept `/uploads/<sha>.<ext>`, a full URL, or bare `<sha>.<ext>`.
        const filename = ref.replace(/^.*\/uploads\//, "").replace(/^\/+/, "");
        if (!/^[0-9a-f]{64}\.[a-z0-9]+$/i.test(filename)) {
            die(`invalid upload ref '${ref}' — expected /uploads/<sha>.<ext> or <sha>.<ext>`);
        }
        const client = buildClient(gOpts(cmd));
        const { bytes, contentType } = await client.downloadUpload(filename);
        const out_path = opts.out ?? join(tmpdir(), `aiball-${filename}`);
        writeFileSync(out_path, bytes);
        out(
            { path: out_path, bytes: bytes.length, content_type: contentType },
            gOpts(cmd),
            (v: { path: string; bytes: number; content_type: string }) =>
                `saved ${v.path} (${v.bytes} bytes, ${v.content_type})`,
        );
    });

program
    .command("check")
    .description(
        "Project-level health check: .aiball.yaml, hook wiring, agent id resolution, daemon reachability, prerequisites, installed commands.",
    )
    .option("--json", "Machine-readable JSON output")
    .action(async (opts: { json?: boolean }, cmd) => {
        const { loadConfig } = await import("./autopoll/config.js");
        const cfg = loadConfig(userCwd());
        const client = buildClient(gOpts(cmd));

        // Source tracking now lives in loadConfig (#B.154) — no need
        // to re-walk the chain here. Previously this block parsed the
        // YAML config as JSON (buggy: always returned null, so every
        // resolved agent showed "[from .mcp.json]" regardless).
        const agentSource = cfg.consumer.agent_source;
        const projectSource = cfg.consumer.project_source;

        // Daemon reachability.
        let daemonUp = false;
        try {
            await client.health();
            daemonUp = true;
        } catch {
            /* down */
        }

        // Resolved unread ping count for the agent (only if daemon up + agent known).
        let pings: number | null = null;
        if (daemonUp && cfg.consumer.agent) {
            try {
                const r = (await new AiballClient({ agentId: cfg.consumer.agent }).pingsCount()) as {
                    unread: number;
                };
                pings = r.unread;
            } catch {
                pings = null;
            }
        }

        // #1563 slice 3 — which wire upstream calls would take, and why.
        // Probed ONLY when this project actually has bindings: a probe spawns
        // `gh --version` + `gh auth status`, and every project without upstream
        // coupling would otherwise pay two subprocesses per `check`.
        const upstreamBindings = cfg.consumer.project ? (cfg.upstream[cfg.consumer.project] ?? []) : [];
        let upstreamInfo: {
            bindings: Array<{ kind: string; ref: string; default?: boolean; transport?: string }>;
            choice: string;
            probes: Array<{ id: string; ok: boolean; detail: string }>;
        } | null = null;
        if (upstreamBindings.length > 0) {
            const { probeAllWires } = await import("./upstream-wire.js");
            const { choice, probes } = await probeAllWires({ kind: "github" });
            upstreamInfo = { bindings: upstreamBindings, choice, probes };
        }

        const payload = {
            cwd: userCwd(),
            config: {
                path: cfg.configPath,
                found: !!cfg.configPath,
            },
            upstream: upstreamInfo,
            autopoll: {
                enabled: cfg.autopoll.enabled,
                volatile: cfg.autopoll.volatile,
                backlog: cfg.autopoll.backlog,
                throttle_seconds: cfg.autopoll.throttle_seconds,
                tone: cfg.autopoll.tone,
                include_recent_tickets: cfg.autopoll.include_recent_tickets,
                reason: cfg.configPath
                    ? cfg.autopoll.enabled
                        ? "enabled via .aiball.yaml"
                        : "explicitly disabled in .aiball.yaml"
                    : "no .aiball.yaml found — hook stays silent",
            },
            consumer: {
                agent: cfg.consumer.agent,
                agent_source: agentSource,
                project: cfg.consumer.project,
                project_source: projectSource,
            },
            daemon: {
                up: daemonUp,
                unread_pings: pings,
            },
            // #269 (david ftprf7) then #1567 phase 3: the prerequisites npm
            // cannot carry. Probed through src/sysdeps.ts — the same lookup the
            // proxy launch uses — and each miss carries the install command for
            // THIS machine's package manager.
            dependencies: checkPrereqs(),
            // #1583 — the commands as the SHELL sees them. Prerequisites say
            // what the machine is missing; this says what the install has lost.
            // Probed by running them, because a launcher whose target vanished
            // still passes an existence test — that's how a whole Windows box
            // went silent after the `.cmd` files were dropped.
            shims: checkShims(),
            // #B.154: deprecation surface — `.mcp.json` env block is
            // the legacy identity-injection mechanism; users should
            // migrate to `.aiball.yaml consumer:*`. Independent of
            // whether the resolved value actually came from that
            // path (presence-in-file is what we flag).
            deprecation: {
                mcp_json_env_block: cfg.mcp_json_deprecated,
            },
        };

        // Honor either local `--json` (legacy) or the global `--json`.
        if (opts.json || gOpts(cmd).json) {
            jsonline(payload);
            return;
        }

        // Human-readable.
        const ok = (b: boolean): string => (b ? "✓" : "·");
        process.stdout.write(`aiball check — cwd: ${payload.cwd}\n\n`);
        process.stdout.write(`config\n`);
        process.stdout.write(`  ${ok(payload.config.found)} .aiball.yaml: ${payload.config.path ?? "(none found by walking up)"}\n`);
        process.stdout.write(`  ${ok(payload.autopoll.enabled)} autopoll: ${payload.autopoll.reason}\n`);
        if (payload.autopoll.enabled) {
            const mode = payload.autopoll.volatile ? "volatile (one-shot)" : "persistent";
            const backlog = payload.autopoll.backlog ? "backlog-trigger" : "pings-only";
            process.stdout.write(`     mode=${mode}, ${backlog}, throttle=${payload.autopoll.throttle_seconds}s, tone=${payload.autopoll.tone}, recent=${payload.autopoll.include_recent_tickets}\n`);
        } else if (!payload.config.found) {
            // #B.154 david: when the Stop hook is wired but no
            // .aiball.yaml exists, the project is half-set-up.
            // Surface the activation command so the user doesn't
            // have to dig into docs.
            process.stdout.write(`     activate with: aiball autopoll init\n`);
        }
        process.stdout.write(`\nconsumer\n`);
        process.stdout.write(`  ${ok(!!payload.consumer.agent)} agent:   ${payload.consumer.agent ?? "(unresolved)"} ${payload.consumer.agent_source ? `[from ${payload.consumer.agent_source}]` : ""}\n`);
        process.stdout.write(`  ${ok(!!payload.consumer.project)} project: ${payload.consumer.project ?? "(unresolved)"} ${payload.consumer.project_source ? `[from ${payload.consumer.project_source}]` : ""}\n`);
        if (payload.upstream) {
            const u = payload.upstream;
            // `auto` picks the first passing probe, gh first — mirror that here
            // so the line says what WOULD happen, not just what is configured.
            const picked = u.choice === "auto"
                ? (u.probes.find((p) => p.ok)?.id ?? "http")
                : u.choice;
            process.stdout.write(`\nupstream\n`);
            process.stdout.write(`  transport: ${u.choice}${u.choice === "auto" ? ` → ${picked}` : ""}\n`);
            for (const p of u.probes) {
                process.stdout.write(`  ${ok(p.ok)} ${p.detail}\n`);
            }
            for (const b of u.bindings) {
                const over = b.transport ? ` [transport: ${b.transport}]` : "";
                process.stdout.write(`  · ${b.ref}${b.default ? " (default)" : ""}${over}\n`);
            }
            if (u.choice !== "auto" && !u.probes.find((p) => p.id === u.choice)?.ok) {
                // Explicit choice + failing probe = calls WILL fail. There is no
                // silent fallback by design, so say it here rather than let it
                // surface as a confusing error at import time.
                process.stdout.write(`  ! transport "${u.choice}" is configured but not usable — upstream calls will fail (no silent fallback)\n`);
            }
        }
        process.stdout.write(`\ndaemon\n`);
        process.stdout.write(`  ${ok(payload.daemon.up)} reachable\n`);
        if (payload.daemon.up && payload.consumer.agent) {
            process.stdout.write(`  ${ok(payload.daemon.unread_pings === 0)} unread pings for ${payload.consumer.agent}: ${payload.daemon.unread_pings ?? "?"}\n`);
        }
        process.stdout.write(`\ndependencies\n`);
        for (const d of payload.dependencies) {
            if (d.present) {
                process.stdout.write(`  ✓ ${d.cmd}: available — ${d.powers}\n`);
                continue;
            }
            // A hard miss and a soft one read differently: one says the thing
            // won't run, the other names exactly what you lose.
            const verdict = d.required
                ? `MISSING — required by ${d.powers}`
                : `missing — ${d.degraded}`;
            process.stdout.write(`  ${d.required ? "✗" : "·"} ${d.cmd}: ${verdict}\n`);
            if (d.install) process.stdout.write(`     install with: ${d.install}\n`);
        }
        const brokenShims = payload.shims.filter((s) => !s.works);
        process.stdout.write(`\ninstalled commands\n`);
        for (const s of payload.shims) {
            process.stdout.write(`  ${ok(s.works)} ${s.cmd}: ${s.detail}\n`);
        }
        if (brokenShims.length > 0) {
            // Naming the repair is the point — a command that vanishes from the
            // PATH gives no clue on its own, and the MCP server failing this way
            // reads as a network drop rather than a broken install.
            process.stdout.write(
                `  ! re-run the installer to rewrite these launchers `
                + `(install.sh on Linux/macOS, install.ps1 on Windows)\n`,
            );
        }
        if (payload.deprecation.mcp_json_env_block) {
            process.stdout.write(
                `\ndeprecation\n` +
                `  ! .mcp.json carries an mcpServers.aiball.env block with AIBALL_AGENT/PROJECT.\n` +
                `    This injection mechanism is deprecated (#B.154). Migrate to .aiball.yaml:\n\n` +
                `        consumer:\n` +
                `          agent: ${payload.consumer.agent ?? "<your-agent-id>"}\n` +
                `          project: ${payload.consumer.project ?? "<your-project>"}\n\n` +
                `    Then drop the env block from .mcp.json. See .aiball.yaml.example.\n`,
            );
        }
        process.stdout.write(`\n`);
    });

program
    .command("reload")
    .description(
        "Reload the daemon's config in place — no downtime, no restart (#407). Asks " +
            "the running daemon over its local API, which works on every platform " +
            "(#2089: signals don't exist on Windows, where killing by pid TERMINATES " +
            "the daemon rather than reloading it). Most aiball config is already read " +
            "fresh per request; this re-reads + validates the global config and is the " +
            "hook for any boot-cached config. For schema migrations (and anything " +
            "code/env-level) use `aiball restart`. `kill -USR2` still works on Linux.",
    )
    .action(async (_opts, cmd) => {
        // #2089 — ask the daemon, don't signal it. A signal is a Linux-only door
        // to the same function, and on Windows `process.kill` ignores the name
        // and terminates the target: the command promising no downtime was the
        // one that stopped the daemon.
        try {
            const r = await new AiballClient().reloadDaemon();
            out(
                { ...r, reloaded: true },
                gOpts(cmd),
                (v: { global_config?: string }) =>
                    `config reloaded in place, no downtime (global=${v.global_config ?? "?"})`,
            );
        } catch (e) {
            die(`could not reach the daemon to reload it: ${(e as Error).message}`);
        }
    });

program
    .command("restart")
    .description(
        "Hard-restart the daemon — re-runs DB migrations, reloads ALL code + env, " +
            "rebinds the socket (#407). Use this for the cases `aiball reload` can't " +
            "cover (schema migrations above all). Same as `kill -HUP` on the daemon — " +
            "identical to the loop's kill-HUP (#388). Goes through whatever supervises " +
            "the daemon: `systemctl --user restart aiball` on Linux, the tray on Windows " +
            "(#2089). With no supervisor (portable / dev) it says so instead of stopping " +
            "a daemon nothing would bring back.",
    )
    .action((_opts, cmd) => {
        // #2089 — one path for both platforms: ask the supervisor on Linux, stop
        // the daemon for the tray to catch on Windows. Either way we never stop
        // it without evidence that something restarts it.
        if (!restartViaSupervisor()) {
            die(
                `could not restart the daemon: ${supervisorHint()} ` +
                    "For config-only changes, `aiball reload` works with no downtime.",
            );
        }
        out(
            { restarted: true },
            gOpts(cmd),
            () => "daemon hard-restarted through its supervisor",
        );
    });

program
    .command("drain")
    .description("Touch the spool dir to nudge the daemon's spool watcher")
    .action(async (_opts, cmd) => {
        const home = aiballHome();
        const spoolDir = join(home, "spool");
        if (existsSync(spoolDir)) {
            const marker = join(spoolDir, ".drain-trigger");
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fs = require("node:fs");
                fs.writeFileSync(marker, "");
                fs.unlinkSync(marker);
            } catch {
                /* daemon will pick up next watch tick */
            }
        }
        // Then print the same status payload, for symmetry with bash.
        await program.parseAsync(["node", "aiball", "status"]);
        void cmd;
    });

// =====================================================================
// auth subcommands (#B.94) — moved to ./cli/auth.ts (#B.213 phase 3.A).
// mcp + bootstrap init → ./cli/bootstrap.ts (#B.213 phase 3.F).
// =====================================================================
registerAuthCommands(program);
registerBootstrapCommands(program);

// =====================================================================
// sandbox subcommands (delegated)
// =====================================================================

registerSandboxCommands(program);

// =====================================================================
// Run
// =====================================================================

program.parseAsync(process.argv).catch((e) => {
    die((e as Error).message);
});
