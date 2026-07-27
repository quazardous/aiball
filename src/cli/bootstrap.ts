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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Command } from "commander";
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { die, userCwd } from "./_helpers.js";
import { applyBootstrapOptions } from "./bootstrap-options.js";
import { globalConfigPath } from "../autopoll/config.js";
import { proxyTokensPath, type ProxyTokenEntry } from "../proxy.js";
import { installRoot as aiballInstallRoot } from "../claude-loop/state.js";

/**
 * Shared `mcp init` body so both `aiball mcp init` and the combined
 * `aiball init` can call it. Returns false when the entry already
 * exists and --force wasn't passed (caller decides if that's an error).
 */
/**
 * #701 — resolve the "new" project name the user is migrating TO and call
 * the daemon's rename endpoint to flip the DB pointer. Done BEFORE the
 * rest of `bootstrapInit` runs so the freshly-written `.aiball.yaml` lines
 * up with whatever the user reads next.
 *
 * Resolution order for the new name : `--project` flag → existing
 * `.aiball.yaml` `consumer.project` → `basename(userCwd())`. Same chain
 * `resolveIdentityHint` uses for the post-init hint.
 */
async function runMigrateFrom(oldName: string, projectFlag: string | undefined): Promise<void> {
    let newName = projectFlag?.trim() ?? "";
    if (!newName) {
        // Probe an existing yaml first ; fall back to cwd basename.
        const yamlPath = join(userCwd(), ".aiball.yaml");
        if (existsSync(yamlPath)) {
            try {
                const parsed = parseYaml(readFileSync(yamlPath, "utf8")) as
                    | { consumer?: { project?: string } }
                    | null;
                const fromYaml = parsed?.consumer?.project?.trim();
                if (fromYaml) newName = fromYaml;
            } catch {
                /* malformed yaml — fall through to basename */
            }
        }
        if (!newName) newName = basename(userCwd()).trim();
    }
    if (!newName) {
        die(`init --migrate-from: could not derive the new project name — pass --project <name> explicitly`);
    }
    if (newName === oldName) {
        die(`init --migrate-from: "${oldName}" already matches the resolved new name "${newName}" — nothing to rename`);
    }
    // Lazy-import the client so a `--help` invocation doesn't open the UDS.
    const { AiballClient } = await import("../client.js");
    const client = new AiballClient();
    try {
        const result = await client.renameProject(oldName, newName);
        const cascadeBits = [
            `tickets:${result.tickets}`,
            `subs:${result.subscriptions}`,
            `rules:${result.rules + result.automation_rules}`,
            `work_filters:${result.work_filters}`,
            `consumers:${result.consumers}`,
            `from_project:${result.tickets_from_project}`,
            `config_overrides:${result.config_overrides}`,
            `token_usage:${result.project_token_usage}`,
        ].join(" ");
        process.stdout.write(
            `renamed project "${result.old_name}" → "${result.new_name}" (${cascadeBits})\n`,
        );
    } catch (e) {
        const msg = (e as Error).message ?? String(e);
        die(`init --migrate-from: rename failed — ${msg}`);
    }
}

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

/**
 * Shared body of `aiball init` (#B.175), reused verbatim by `claude-loop init`
 * (#304 — david: "alias de aiball init"). Writes .mcp.json + a minimal
 * .aiball.yaml, then prints the identity hint.
 */
export async function bootstrapInit(opts: {
    force?: boolean;
    private?: boolean;
    /** #603 (david 4dzxp2) : seed `consumer.agent` into .aiball.yaml. `--agent`
     *  alias on the CLI is mapped to this same field upstream. Existing yaml
     *  gets patched in place (Document API, comments preserved). */
    consumer?: string;
    /** #603 : seed `consumer.project` into .aiball.yaml. Patches existing yaml
     *  in place when present. */
    project?: string;
    /** #612 (david) : seed `consumer.no_claim: true|false` into .aiball.yaml.
     *  When undefined, the existing field is left untouched (init respecte
     *  les param déjà posés sauf si dans la ligne de flag). */
    noClaim?: boolean;
    /** #701 (david) : rename the project from this name to the new project
     *  name BEFORE the rest of the init runs. The new name is resolved from
     *  `--project` if passed, else from an existing `.aiball.yaml`'s
     *  consumer.project, else from `basename(userCwd())`. Typo-recovery in
     *  one shot — calls the same `POST /api/projects/:name/rename` the
     *  `aiball project rename` CLI uses, so the cascade across tickets /
     *  subs / rules / etc. lands inside the daemon's transaction. */
    migrateFrom?: string;
}): Promise<void> {
    const force = opts.force === true;
    if (opts.migrateFrom) {
        await runMigrateFrom(opts.migrateFrom, opts.project);
    }
    await mcpInitAction(force);
    // Inline minimal .aiball.yaml — the verbose annotated template lives at
    // .aiball.yaml.example; the bootstrap stays tight.
    const yamlPath = join(userCwd(), ".aiball.yaml");
    const yamlExists = existsSync(yamlPath);
    const hasIdentity = !!opts.consumer || !!opts.project || opts.noClaim !== undefined;
    const hasProjectType = opts.private === true;
    if (yamlExists && !force) {
        // #603 (4dzxp2) + #612 : even when the yaml exists, patch in
        // --consumer / --project / --no-claim so subsequent inits actually
        // persist new flags. Preserves existing keys + comments via the
        // yaml Document API (`init respecte les param déjà posés sauf si
        // dans la ligne de flag` — david #612).
        if (hasIdentity) {
            patchIdentity(yamlPath, opts.consumer, opts.project, opts.noClaim);
        }
        // #685 — `--private` was silently ignored on existing yaml (only the
        // FRESH-create branch honored it). Mirror patchIdentity : patch
        // `project_type: private` in place. Without this, `claude-loop init
        // --private` is a no-op after the first init.
        if (hasProjectType) {
            patchProjectType(yamlPath, "private");
        }
        if (!hasIdentity && !hasProjectType) {
            process.stdout.write(`${yamlPath}: already exists — re-run with --force to overwrite\n`);
        }
    } else {
        // #593 — `--private` seeds `project_type: private` so the MCP `welcome`
        // tool serves the private kit (relaxed conventions : internal refs OK,
        // French in comments OK, LICENSE optional…). Default = public (the
        // welcome tool's fail-safe applies the strict public conventions when
        // unset, so a project that's actually private should declare it).
        const projectTypeLine = opts.private === true ? "project_type: private\n" : "";
        const consumerLines = hasIdentity
            ? "consumer:\n"
                + (opts.consumer ? `  agent: ${opts.consumer}\n` : "")
                + (opts.project ? `  project: ${opts.project}\n` : "")
                + (opts.noClaim !== undefined ? `  no_claim: ${opts.noClaim}\n` : "")
            : "";
        const body =
            "# Bootstrapped by `aiball init`. See .aiball.yaml.example for the full annotated template.\n" +
            projectTypeLine +
            consumerLines +
            "autopoll:\n" +
            "  enabled: true\n";
        writeFileSync(yamlPath, body);
        const tags: string[] = ["autopoll enabled"];
        if (opts.private === true) tags.push("project_type: private");
        if (opts.consumer) tags.push(`consumer.agent: ${opts.consumer}`);
        if (opts.project) tags.push(`consumer.project: ${opts.project}`);
        if (opts.noClaim !== undefined) tags.push(`consumer.no_claim: ${opts.noClaim}`);
        process.stdout.write(`${yamlExists && force ? "overwrote" : "created"} ${yamlPath} (${tags.join(", ")})\n`);
    }
    // #651 david `fzsqeg` — drop the aiball Claude Code skill into the
    // GLOBAL ~/.claude/skills/aiball/ on first init. Idempotent : skipped
    // if already present (the user gets a one-liner pointing to
    // `aiball init skill --overwrite` for refresh). Discipline-bearing
    // skill auto-suggests on aiball-related contexts in the next Claude
    // Code session ; bundling it with init means `claude-loop init` ALSO
    // gets it (it delegates to bootstrapInit) — david's expectation.
    maybeInstallSkillGlobal();
    process.stdout.write(`\n${await resolveIdentityHint()}\n`);
    process.stdout.write(`Run \`aiball check\` to verify everything resolves.\n`);
}

/**
 * #603 + #612 — merge `consumer.agent` / `consumer.project` / `consumer.no_claim`
 * into an existing `.aiball.yaml`. Document API so comments + unrelated keys
 * survive. Each field is only touched when explicitly passed (undefined → keep
 * whatever was there) — `init est respectueux des param déjà posés sauf si
 * dans la ligne de flag` (david #612).
 */
/**
 * #685 — set top-level `project_type:` on an existing `.aiball.yaml`,
 * preserving comments + unrelated keys via the Document API. Same
 * preservation contract as `patchIdentity`. Idempotent : no rewrite if
 * the value is already the requested one.
 */
function patchProjectType(path: string, value: string): void {
    let doc;
    try {
        doc = parseDocument(readFileSync(path, "utf8"));
    } catch {
        die(`init: ${path} exists but isn't valid YAML — fix or remove it first`);
    }
    const prev = doc.get("project_type");
    if (prev === value) {
        process.stdout.write(`${path}: project_type already '${value}' (no change)\n`);
        return;
    }
    doc.set("project_type", value);
    writeFileSync(path, String(doc));
    process.stdout.write(`${path}: patched project_type='${value}'${prev ? ` (was '${prev}')` : ""}\n`);
}

function patchIdentity(path: string, agent: string | undefined, project: string | undefined, noClaim: boolean | undefined): void {
    let doc;
    try {
        doc = parseDocument(readFileSync(path, "utf8"));
    } catch {
        die(`init: ${path} exists but isn't valid YAML — fix or remove it first`);
    }
    if (!doc.has("consumer")) doc.set("consumer", {});
    const consumer = doc.get("consumer") as { set: (k: string, v: unknown) => void } | undefined;
    if (!consumer || typeof (consumer as { set?: unknown }).set !== "function") {
        die(`init: ${path} has a non-mapping 'consumer' value — fix by hand, then re-run`);
    }
    const changed: string[] = [];
    if (agent) { consumer.set("agent", agent); changed.push(`agent=${agent}`); }
    if (project) { consumer.set("project", project); changed.push(`project=${project}`); }
    if (noClaim !== undefined) { consumer.set("no_claim", noClaim); changed.push(`no_claim=${noClaim}`); }
    writeFileSync(path, String(doc));
    process.stdout.write(`${path}: patched consumer (${changed.join(", ")})\n`);
}

/**
 * #380: write the `providers.tailscale` block into the GLOBAL config
 * (`~/.config/aiball/config.yaml`). Uses the yaml Document API so existing
 * keys AND comments are preserved — only the tailscale entry is set. Remote
 * access is host-level, so this is global (not per-project `.aiball.yaml`).
 */
/**
 * #651 david `cbeqv3`+`ycajaf` — deploy the aiball Claude Code skill shipped
 * with the install (`<installRoot>/skills/aiball/SKILL.md`) into a destination
 * `.claude/skills/aiball/SKILL.md` so the next Claude Code session has the
 * ticket-reply discipline + MCP usage rules in-context without relying on
 * memory alone. Default destination is global (`~/.claude/skills/`) since
 * the discipline is agent-behavior, not project-specific. `--project` lands
 * it under `<cwd>/.claude/skills/` for project-scoped overrides.
 */
/**
 * Pure helper that copies the skill — returns a verdict instead of
 * dying so it can be called from `bootstrapInit` (where a pre-existing
 * skill is a no-op, not a fatal error). The CLI wrapper below turns
 * "already exists" into a `die()` when the user explicitly asked for
 * the skill via `init skill`.
 */
export type SkillInstallVerdict =
    | { kind: "installed"; dest: string; src: string }
    | { kind: "skipped-exists"; dest: string }
    | { kind: "missing-source"; src: string };

function copySkill(opts: { project: boolean; global: boolean; target?: string; force: boolean }): SkillInstallVerdict {
    // #651 fzsqeg fix : resolveInstallRoot() returns process.cwd() (where
    // the user invoked aiball from), not where aiball is actually
    // installed. The shipped skill lives at <installRoot>/skills/aiball/SKILL.md
    // and `aiballInstallRoot()` walks up from the source file's URL to
    // find that path correctly across hard / symlink install modes.
    const installRoot = aiballInstallRoot();
    const src = join(installRoot, "skills", "aiball", "SKILL.md");
    if (!existsSync(src)) return { kind: "missing-source", src };
    let destDir: string;
    if (opts.target !== undefined) {
        destDir = opts.target;
    } else if (opts.project) {
        destDir = join(userCwd(), ".claude", "skills");
    } else {
        // --global is the default ; explicit flag included for clarity
        destDir = join(homedir(), ".claude", "skills");
    }
    const skillDir = join(destDir, "aiball");
    const dest = join(skillDir, "SKILL.md");
    if (existsSync(dest) && !opts.force) return { kind: "skipped-exists", dest };
    mkdirSync(skillDir, { recursive: true });
    const content = readFileSync(src, "utf8");
    writeFileSync(dest, content, "utf8");
    return { kind: "installed", dest, src };
}

export function installSkill(opts: { project: boolean; global: boolean; target?: string; force: boolean }): void {
    if (opts.project && opts.global) {
        die("init skill: --project and --global are mutually exclusive");
    }
    const v = copySkill(opts);
    if (v.kind === "missing-source") {
        die(`init skill: source SKILL.md not found at ${v.src} — is the install root correct?`);
    }
    if (v.kind === "skipped-exists") {
        die(`init skill: ${v.dest} already exists — pass --overwrite to refresh`);
    }
    process.stdout.write(
        [
            `Installed aiball skill → ${v.dest}`,
            ``,
            `Source: ${v.src}`,
            `The skill is auto-suggested by Claude Code when it sees an aiball-related context.`,
            `Re-run with --overwrite to refresh after an aiball upgrade.`,
            ``,
        ].join("\n"),
    );
}

/**
 * #651 david `fzsqeg` — called from `bootstrapInit` so `aiball init` and
 * `claude-loop init` automatically deploy the skill to the GLOBAL
 * ~/.claude/skills/aiball/ on first run. Idempotent : a pre-existing
 * skill is left alone (no clobber) ; the user can refresh via
 * `aiball init skill --overwrite` after an upgrade.
 */
function maybeInstallSkillGlobal(): void {
    const v = copySkill({ project: false, global: true, force: false });
    if (v.kind === "installed") {
        process.stdout.write(`Installed aiball skill → ${v.dest} (Claude Code will pick it up next session)\n`);
    } else if (v.kind === "skipped-exists") {
        process.stdout.write(`aiball skill already at ${v.dest} (refresh with: aiball init skill --overwrite)\n`);
    }
    // missing-source is silent here — bootstrap shouldn't loudly fail
    // when the install root is non-standard ; the explicit `init skill`
    // command surfaces it.
}

function initTailscale(opts: { http: boolean; port?: number; autostart: boolean }): void {
    const path = globalConfigPath();
    let doc;
    try {
        doc = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "");
    } catch {
        die(`init tailscale: ${path} exists but isn't valid YAML — fix or remove it first`);
    }
    const entry: Record<string, unknown> = {
        enabled: true,
        autostart: opts.autostart,
        mode: opts.http ? "http" : "https",
    };
    if (opts.port !== undefined) entry.port = opts.port;
    doc.setIn(["providers", "tailscale"], entry);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, doc.toString(), "utf8");

    process.stdout.write(
        [
            `Wrote providers.tailscale → ${path}`,
            ``,
            `  providers:`,
            `    tailscale:`,
            `      enabled: true`,
            `      autostart: ${opts.autostart}`,
            `      mode: ${opts.http ? "http" : "https"}`,
            ...(opts.port !== undefined ? [`      port: ${opts.port}`] : []),
            ``,
            `Apply autostart-at-boot (regenerates the systemd unit, then restart):`,
            `  bash install.sh && systemctl --user restart aiball`,
            `Or bring it up right now (no restart):  aiball providers up`,
            `Check:  aiball status`,
            ``,
        ].join("\n"),
    );
}

/**
 * #394 volet B: write the `proxy:` block into the GLOBAL config
 * (`~/.config/aiball/config.yaml`) so this daemon boots as a transparent
 * relay to a REMOTE aiball. Same Document-API approach as initTailscale —
 * existing keys + comments are preserved; only `proxy` is set. Host-level
 * (every local client on this host relays), so it's global, not per-project.
 */
function initProxy(opts: { url: string; token: string; strict?: boolean }): void {
    const path = globalConfigPath();
    let doc;
    try {
        doc = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "");
    } catch {
        die(`proxy init: ${path} exists but isn't valid YAML — fix or remove it first`);
    }
    doc.setIn(["proxy", "url"], opts.url);
    if (opts.token) doc.setIn(["proxy", "token"], opts.token);
    // #394 « tuer le point faible » : strict ⇒ pas d'injection du token node ;
    // chaque requête doit porter son propre bearer per-consumer, sinon 401.
    if (opts.strict) doc.setIn(["proxy", "strict"], true);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, doc.toString(), "utf8");

    process.stdout.write(
        [
            `Wrote proxy → ${path}`,
            ``,
            `  proxy:`,
            `    url: ${opts.url}`,
            ...(opts.token ? [`    token: ${opts.token.slice(0, 12)}…`] : [`    token: (none — set one with --token)`]),
            ...(opts.strict ? [`    strict: true`] : []),
            ``,
            `This daemon will relay /api/* + /uploads/* to ${opts.url}.`,
            ...(opts.strict
                ? [
                    `STRICT mode: the node token is NEVER injected — every relayed request`,
                    `must carry its own per-consumer bearer (else 401). Provision each`,
                    `local client with a token minted on the REMOTE (aiball auth issue`,
                    `--consumer <id>); token-less clients (web UI / CLI over the UDS) will`,
                    `be rejected. This closes the cross-host weak point (docs/SECURITY.md).`,
                ]
                : [`Mint the token on the REMOTE with:  aiball auth issue --node`]),
            `Apply:  systemctl --user restart aiball`,
            `Check:  aiball status`,
            ``,
        ].join("\n"),
    );
}

/** #394 node-managed token store helpers (proxy node side, DB-less). */
function maskToken(t: string): string {
    return t.length > 14 ? `${t.slice(0, 12)}…` : t;
}

function readProxyTokens(): ProxyTokenEntry[] {
    const p = proxyTokensPath();
    if (!existsSync(p)) return [];
    try {
        const raw = (parseYaml(readFileSync(p, "utf8")) ?? {}) as { tokens?: ProxyTokenEntry[] };
        return Array.isArray(raw.tokens) ? raw.tokens : [];
    } catch {
        die(`proxy token: ${p} exists but isn't valid YAML — fix or remove it first`);
    }
}

function writeProxyTokens(tokens: ProxyTokenEntry[]): void {
    const p = proxyTokensPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, stringifyYaml({ tokens }), "utf8");
    chmodSync(p, 0o600);
}

/**
 * `aiball proxy token add` — map a LOCAL token (handed to a local client) to an
 * upstream per-consumer A-token. The proxy swaps it at egress so A gets hard
 * per-consumer proof and the A-token never lives on the client.
 */
function addProxyToken(opts: { consumer: string; remote: string; local?: string }): void {
    const tokens = readProxyTokens();
    const local = opts.local?.trim() || `aiball-local-${randomBytes(24).toString("hex")}`;
    if (tokens.some((t) => t.local === local)) die(`proxy token add: that local token is already in the store`);
    tokens.push({ local, remote: opts.remote, consumer: opts.consumer });
    writeProxyTokens(tokens);
    process.stdout.write(
        [
            `Added mapping → ${proxyTokensPath()}`,
            ``,
            `  consumer: ${opts.consumer}`,
            `  local:    ${local}`,
            `  remote:   ${maskToken(opts.remote)}  (per-consumer A-token; stays on this node)`,
            ``,
            `Give the LOCAL token to the client (export AIBALL_TOKEN=${local}, or`,
            `claude-loop init --aiball-token ${local}). The proxy swaps it for the`,
            `A-token at egress → A authenticates as '${opts.consumer}' (hard proof).`,
            `Apply:  systemctl --user restart aiball`,
            ``,
        ].join("\n"),
    );
}

function listProxyTokensCmd(): void {
    const tokens = readProxyTokens();
    if (tokens.length === 0) {
        process.stdout.write("(no proxy token mappings)\n");
        return;
    }
    for (const t of tokens) {
        process.stdout.write(
            `${(t.consumer || "(no consumer)").padEnd(20)}  local=${maskToken(t.local)}  →  remote=${maskToken(t.remote)}\n`,
        );
    }
}

function revokeProxyToken(needle: string): void {
    const tokens = readProxyTokens();
    const matches = tokens.filter(
        (t) => t.local === needle || t.local.startsWith(needle) || t.consumer === needle,
    );
    if (matches.length === 0) die(`proxy token revoke: nothing matching '${needle}'`);
    if (matches.length > 1) {
        die(
            `proxy token revoke: '${needle}' matches ${matches.length} entries — be more specific:\n` +
                matches.map((t) => `  ${t.consumer}  ${maskToken(t.local)}`).join("\n"),
        );
    }
    writeProxyTokens(tokens.filter((t) => t !== matches[0]));
    process.stdout.write(`revoked local token for '${matches[0].consumer}' (${maskToken(matches[0].local)})\n`);
}

export function registerBootstrapCommands(program: Command): void {
    // #600 david `483um7` — `aiball mcp init` killed : `aiball init` (and
    // `claude-loop init`) already write .mcp.json + .aiball.yaml together
    // since #B.175. The standalone path was vestigial and the parent
    // `mcp` namespace had no other subcommands. The action stub stays
    // for one release so scripts that called it get a clear redirect.
    const mcp = program
        .command("mcp")
        .description("Manage the aiball entry in this project's .mcp.json");

    mcp
        .command("init")
        .description("(removed in 0.27) — use `aiball init` (combines mcp + autopoll setup)")
        .allowExcessArguments(true)
        .action(() => {
            die("`aiball mcp init` was removed — use `aiball init` (it writes .mcp.json + .aiball.yaml in one shot). #600");
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
    const initCmd = applyBootstrapOptions(program
        .command("init")
        .description("Bootstrap a project: write .mcp.json + .aiball.yaml (combines mcp + autopoll setup)"))
        .action(async (opts: { force?: boolean; private?: boolean; agent?: string; consumer?: string; project?: string; claim?: boolean; migrateFrom?: string }) => {
            // #612 — commander's `--no-X` sets `opts.X = false` when passed,
            // defaults to `true` otherwise. We want a tri-state for the
            // yaml patcher (undefined → leave existing field alone, david's
            // rule "init respecte les param déjà posés sauf si dans la
            // ligne de flag"). Detect the flag explicitly via argv.
            const noClaim = process.argv.includes("--no-claim") ? true : undefined;
            await bootstrapInit({
                ...opts,
                consumer: opts.consumer ?? opts.agent,
                noClaim,
                migrateFrom: opts.migrateFrom,
            });
        });

    // #651: `aiball init skill` — deploy the shipped aiball Claude Code skill
    // (skills/aiball/SKILL.md in the install root) into a user's ~/.claude/skills/
    // (global, default) or <cwd>/.claude/skills/ (--project). The skill
    // teaches the ticket-reply discipline (then:resolved/then:plan vs plain
    // comments) so the next session has the rules in-context without relying
    // on memory alone.
    initCmd
        .command("skill")
        .description("Install the aiball Claude Code skill into ~/.claude/skills/aiball/ (or <cwd>/.claude/skills/aiball/ with --project)")
        .option("--project", "Install into <cwd>/.claude/skills/ instead of ~/.claude/skills/")
        .option("--global", "Install into ~/.claude/skills/ (default)")
        .option("--target <path>", "Explicit destination directory (overrides --project / --global ; SKILL.md lands at <path>/aiball/SKILL.md)")
        .option("--overwrite", "Overwrite an existing SKILL.md at the destination (parent `init --force` is reserved for project bootstrap)")
        .action((o: { project?: boolean; global?: boolean; target?: string; overwrite?: boolean }) => {
            installSkill({
                project: o.project === true,
                global: o.global === true,
                target: o.target,
                force: o.overwrite === true,
            });
        });

    // #380: `aiball init tailscale` — configure host-level remote access by
    // writing the `providers.tailscale` block to the GLOBAL config. The daemon
    // brings it up at boot (systemd ExecStartPost) or via `aiball providers up`.
    initCmd
        .command("tailscale")
        .description("Configure tailscale remote access (writes providers.tailscale to ~/.config/aiball/config.yaml)")
        .option("--http", "Serve plain HTTP on :80 instead of HTTPS on :443 (no certs)")
        .option("--port <n>", "Listen-port override (default 443 https / 80 http)")
        .option("--no-autostart", "Configure but don't bring it up automatically with the daemon")
        .action((o: { http?: boolean; port?: string; autostart?: boolean }) => {
            initTailscale({
                http: o.http === true,
                port: o.port !== undefined ? Number(o.port) : undefined,
                autostart: o.autostart !== false,
            });
        });

    // #394 volet B: `aiball proxy init` — configure this daemon as a transparent
    // relay to a REMOTE aiball by writing the `proxy:` block to the GLOBAL config.
    // The daemon picks it up at boot (createApp → proxy mode). Host-level.
    const proxy = program.command("proxy").description("Proxy-node mode: relay this daemon to a remote aiball (#394)");
    proxy
        .command("init")
        .description("Configure proxy-node mode (writes the proxy: block to ~/.config/aiball/config.yaml)")
        .requiredOption("--url <url>", "Remote aiball URL to relay to (e.g. https://A-host:7777)")
        .option("--token <token>", "Node service token (mint on the remote with `aiball auth issue --node`)")
        .option("--strict", "Never inject the node token: every relayed request must carry its own per-consumer bearer (else 401). Closes the cross-host weak point (#394).")
        .action((o: { url: string; token?: string; strict?: boolean }) => {
            initProxy({ url: o.url, token: o.token ?? "", strict: o.strict === true });
        });

    // #394 node-managed token store: map LOCAL tokens → upstream per-consumer
    // A-tokens. The proxy swaps them at egress (hard per-consumer proof at A,
    // A-token custody on the node). DB-less — pure file store on machine B.
    const proxyToken = proxy
        .command("token")
        .description("Node-managed token store: map local tokens → upstream per-consumer A-tokens (#394)");
    proxyToken
        .command("add")
        .description("Add a local→remote mapping (generates the local token unless --local is given)")
        .requiredOption("--consumer <id>", "Consumer the A-token proves (bookkeeping + provisioning hint)")
        .requiredOption("--remote <token>", "Per-consumer A-token minted on the remote (`aiball auth issue --consumer <id>`)")
        .option("--local <token>", "Use this local token instead of generating one")
        .action((o: { consumer: string; remote: string; local?: string }) => {
            addProxyToken({ consumer: o.consumer, remote: o.remote, local: o.local });
        });
    proxyToken
        .command("list")
        .description("List the local→remote token mappings (tokens masked)")
        .action(() => listProxyTokensCmd());
    proxyToken
        .command("revoke <local-or-consumer>")
        .description("Remove a mapping by local token (full or unique prefix) or by consumer")
        .action((needle: string) => revokeProxyToken(needle));

    // #600 v7z5u6 — `stop-hook` paths removed entirely. claude-loop CLI-injects
    // hooks per session via `--settings <tmpfile>` ; the persistent .claude/settings.json
    // wiring path is gone. Stub `aiball stop-hook install` kept to redirect users.
    const stopHook = program.command("stop-hook").description("(removed) — claude-loop injects hooks per session; no persistent wiring needed");
    stopHook
        .command("install")
        .description("(removed) — claude-loop injects hooks per session; no persistent wiring needed")
        .allowExcessArguments(true)
        .action(() => {
            die("`aiball stop-hook install` was removed — claude-loop CLI-injects hooks per session. #600");
        });
}
