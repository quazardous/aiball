/**
 * `aiball mcp` + top-level `aiball init` bootstrap commands (carved
 * out of cli.ts in #B.213 phase 3.F on 2026-05-19). Behavior-
 * preserving move.
 *
 * `mcpInitAction` is the shared body called by both `aiball mcp init`
 * and the combined `aiball init`. `resolveIdentityHint` prints the
 * post-bootstrap "Next:" line.
 *
 * Exposed entry point: `registerBootstrapCommands(program)`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Command } from "commander";
import { die, userCwd } from "./_helpers.js";

/**
 * Shared `mcp init` body so both `aiball mcp init` and the combined
 * `aiball init` can call it. Returns false when the entry already
 * exists and --force wasn't passed (caller decides if that's an error).
 */
async function mcpInitAction(force: boolean): Promise<void> {
    const path = join(userCwd(), ".mcp.json");
    type McpFile = { mcpServers?: Record<string, unknown> };
    let json: McpFile = { mcpServers: {} };
    let existed = false;
    if (existsSync(path)) {
        existed = true;
        try {
            json = JSON.parse(readFileSync(path, "utf8")) as McpFile;
        } catch {
            die(`${path} exists but is invalid JSON — fix it by hand, then re-run`);
        }
        if (!json.mcpServers || typeof json.mcpServers !== "object") {
            json.mcpServers = {};
        }
    }
    const servers = json.mcpServers as Record<string, unknown>;
    const had = "aiball" in servers;
    if (had && !force) {
        process.stdout.write(`${path}: aiball entry already present — re-run with --force to overwrite (drops legacy env block)\n`);
        return;
    }
    servers.aiball = { command: "aiball-mcp" };
    writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
    if (!existed) {
        process.stdout.write(`created ${path} with the aiball MCP entry\n`);
    } else if (!had) {
        process.stdout.write(`${path}: added aiball MCP entry (other servers preserved)\n`);
    } else {
        process.stdout.write(`${path}: aiball entry rewritten to canonical form (legacy env block dropped if any)\n`);
    }
}

/**
 * Build the post-bootstrap "Next:" hint. Reads the resolved config so
 * the hint shows the *actual* identity that will be used, not a
 * generic `<basename(cwd)>-claude` template. #B.209: david set
 * `consumer.project: m2m` in his .aiball.yaml to avoid an uppercase
 * `M2M-claude` agent name, but the old hint still printed the
 * template, which read as "your override was ignored".
 */
async function resolveIdentityHint(): Promise<string> {
    try {
        const { loadConfig } = await import("../autopoll/config.js");
        const cfg = loadConfig(userCwd());
        const agent = cfg.consumer.agent;
        const project = cfg.consumer.project;
        const sourceTag = cfg.consumer.agent_source
            ? ` [from ${cfg.consumer.agent_source}]`
            : "";
        return [
            `Next: identity resolves to '${agent}'${sourceTag}.`,
            project
                ? `      default project: '${project}'.`
                : `      (no default project — set 'consumer.project' in .aiball.yaml or export AIBALL_PROJECT)`,
            `      Override via .aiball.yaml keys 'consumer.agent' and 'consumer.project' if needed.`,
        ].join("\n");
    } catch {
        return `Next: identity defaults to '${basename(userCwd())}-claude'. Override via .aiball.yaml keys 'consumer.agent' and 'consumer.project' if needed.`;
    }
}

export function registerBootstrapCommands(program: Command): void {
    const mcp = program
        .command("mcp")
        .description("Manage the aiball entry in this project's .mcp.json");

    mcp
        .command("init")
        .description("Add the aiball MCP server to .mcp.json at cwd (preserves any existing entries)")
        .option("--force", "Overwrite an existing aiball entry (drops any legacy env block — #B.154)")
        .action(async (opts: { force?: boolean }) => {
            await mcpInitAction(opts.force === true);
            process.stdout.write(`\n${await resolveIdentityHint()}\n`);
        });

    /**
     * Combined bootstrap: `.mcp.json` (MCP wiring) + `.aiball.yaml`
     * (autopoll-on, identity overrides optional). David's ask (#B.175
     * "tu parle aussi de aiball autopoll init ??"): one command for
     * the Quickstart, instead of having the user run two.
     *
     * `.aiball.yaml` body is intentionally minimal — just enough to
     * flip autopoll on. The verbose annotated template lives at
     * `.aiball.yaml.example` for users who want to tune knobs.
     */
    program
        .command("init")
        .description("Bootstrap a project: write .mcp.json + .aiball.yaml (combines `mcp init` + `autopoll init`)")
        .option("--force", "Overwrite existing entries (passes through to both subactions)")
        .action(async (opts: { force?: boolean }) => {
            const force = opts.force === true;
            await mcpInitAction(force);
            // Inline minimal .aiball.yaml — don't pull the example
            // template here, that one is reference doc with 60+ lines
            // of comments. The bootstrap should be tight.
            const yamlPath = join(userCwd(), ".aiball.yaml");
            if (existsSync(yamlPath) && !force) {
                process.stdout.write(`${yamlPath}: already exists — re-run with --force to overwrite\n`);
            } else {
                const body =
                    "# Bootstrapped by `aiball init`. See .aiball.yaml.example for the full annotated template.\n" +
                    "autopoll:\n" +
                    "  enabled: true\n";
                writeFileSync(yamlPath, body);
                process.stdout.write(`${existsSync(yamlPath) && force ? "overwrote" : "created"} ${yamlPath} (autopoll enabled)\n`);
            }
            process.stdout.write(`\n${await resolveIdentityHint()}\n`);
            process.stdout.write(`Run \`aiball check\` to verify everything resolves.\n`);
        });
}
