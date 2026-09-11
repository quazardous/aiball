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
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import type { Command } from "commander";
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { die, userCwd } from "./_helpers.js";
import { applyBootstrapOptions } from "./bootstrap-options.js";
import { globalConfigPath } from "../autopoll/config.js";
import { proxyTokensPath, type ProxyTokenEntry } from "../proxy.js";
import { resolveDisplayHost } from "../proxy-host-providers.js";
import { deriveSubAgentName } from "./sub-agent-name.js";
import { resolveSubAgentPreset, isConsumerRole } from "./sub-agent-preset.js";
import { savePairingRequest } from "../node-pairing-request.js";
import { collectPendingPairing } from "../node-pairing-collect.js";
import { restartViaSupervisor, supervisorHint } from "../supervisor-restart.js";
import { writeProxyConfig } from "../proxy-config-write.js";
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
/** #2091 — the project this checkout already declares, if any. Same read
 *  `runMigrateFrom` does below; a malformed yaml is simply "no answer". */
/** The agent this checkout already declares, if any. Re-running `--sub-agent`
 *  must not rename an existing one — see `resolveSubAgentPreset`. */
function readYamlAgent(): string | null {
    const yamlPath = join(userCwd(), ".aiball.yaml");
    if (!existsSync(yamlPath)) return null;
    try {
        const parsed = parseYaml(readFileSync(yamlPath, "utf8")) as
            | { consumer?: { agent?: string } }
            | null;
        return parsed?.consumer?.agent?.trim() || null;
    } catch {
        return null;
    }
}

function readYamlProject(): string | null {
    const yamlPath = join(userCwd(), ".aiball.yaml");
    if (!existsSync(yamlPath)) return null;
    try {
        const parsed = parseYaml(readFileSync(yamlPath, "utf8")) as
            | { consumer?: { project?: string } }
            | null;
        return parsed?.consumer?.project?.trim() || null;
    } catch {
        return null;
    }
}

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
    /** Seed `consumer.role: lead|crew` into .aiball.yaml. Undefined leaves the
     *  existing field untouched, like `noClaim`.
     *
     *  The key already existed — `autopoll/config.ts` reads `lead`/`crew`, and
     *  `start` has a `--role` flag — but `init` could not WRITE it. So a role
     *  had to be typed into the yaml by hand, and `--sub-agent` could not
     *  produce the thing it names. See `subAgent`. */
    role?: "lead" | "crew";
    /** #2180 — seed `claude.deny_tools` with the file and shell tools, for an
     *  agent that steers from the board and must not read code. Explicit and
     *  opt-in: not implied by any agent type. */
    denyCode?: boolean;
    /** #701 (david) : rename the project from this name to the new project
     *  name BEFORE the rest of the init runs. The new name is resolved from
     *  `--project` if passed, else from an existing `.aiball.yaml`'s
     *  consumer.project, else from `basename(userCwd())`. Typo-recovery in
     *  one shot — calls the same `POST /api/projects/:name/rename` the
     *  `aiball project rename` CLI uses, so the cascade across tickets /
     *  subs / rules / etc. lands inside the daemon's transaction. */
    migrateFrom?: string;
    /** #2091 — the one-gesture sub-agent. `true` (bare `--sub-agent`) derives a
     *  name; a string uses it verbatim. Either way it implies assignment-only
     *  AND `role: crew`, which together are what make it a sub-agent rather
     *  than a peer. */
    subAgent?: string | boolean;
}): Promise<void> {
    const force = opts.force === true;
    // #2097 — refuse a role the runtime would ignore. The flag takes a free
    // string; `autopoll/config.ts` honours only `lead` and `crew` and leaves
    // anything else null, which behaves as lead. Accepting a typo would write
    // it to the yaml and print it back, while the daemon gave the agent the
    // opposite standing — a file that says one thing and a runtime that does
    // another. Refusing costs one line.
    const givenRole: unknown = opts.role;
    if (givenRole !== undefined && !isConsumerRole(givenRole)) {
        die(`--role must be 'lead' or 'crew' (got '${String(givenRole)}')`);
    }
    // #2091 — resolve the preset BEFORE anything reads `consumer` / `noClaim`,
    // so the rest of the function has a single shape to handle. An explicit
    // --agent or --no-claim still wins: the preset fills blanks, it does not
    // overrule what was actually asked for.
    if (opts.subAgent !== undefined && opts.subAgent !== false) {
        const resolved = resolveSubAgentPreset({
            ...opts,
            yamlConsumer: readYamlAgent(),
        }, opts.subAgent, () => deriveSubAgentName({
            project: opts.project ?? readYamlProject(),
            dirBase: basename(userCwd()),
            host: resolveDisplayHost()?.host ?? null,
        }));
        opts.consumer = resolved.consumer;
        opts.noClaim = resolved.noClaim;
        opts.role = resolved.role;
    }
    if (opts.migrateFrom) {
        await runMigrateFrom(opts.migrateFrom, opts.project);
    }
    await mcpInitAction(force);
    // Inline minimal .aiball.yaml — the verbose annotated template lives at
    // .aiball.yaml.example; the bootstrap stays tight.
    const yamlPath = join(userCwd(), ".aiball.yaml");
    const yamlExists = existsSync(yamlPath);
    const hasIdentity = !!opts.consumer || !!opts.project || opts.noClaim !== undefined
        || opts.role !== undefined;
    const hasProjectType = opts.private === true;
    const hasDenyCode = opts.denyCode === true;
    if (yamlExists && !force) {
        // #603 (4dzxp2) + #612 : even when the yaml exists, patch in
        // --consumer / --project / --no-claim so subsequent inits actually
        // persist new flags. Preserves existing keys + comments via the
        // yaml Document API (`init respecte les param déjà posés sauf si
        // dans la ligne de flag` — david #612).
        if (hasIdentity) {
            patchIdentity(yamlPath, opts.consumer, opts.project, opts.noClaim, opts.role);
        }
        // #685 — `--private` was silently ignored on existing yaml (only the
        // FRESH-create branch honored it). Mirror patchIdentity : patch
        // `project_type: private` in place. Without this, `claude-loop init
        // --private` is a no-op after the first init.
        if (hasProjectType) {
            patchProjectType(yamlPath, "private");
        }
        if (hasDenyCode) {
            patchDenyTools(yamlPath);
        }
        if (!hasIdentity && !hasProjectType && !hasDenyCode) {
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
                + (opts.role !== undefined ? `  role: ${opts.role}\n` : "")
            : "";
        const body =
            "# Bootstrapped by `aiball init`. See .aiball.yaml.example for the full annotated template.\n" +
            projectTypeLine +
            consumerLines +
            (hasDenyCode ? denyCodeYamlBlock() : "") +
            "autopoll:\n" +
            "  enabled: true\n";
        writeFileSync(yamlPath, body);
        const tags: string[] = ["autopoll enabled"];
        if (opts.private === true) tags.push("project_type: private");
        if (opts.consumer) tags.push(`consumer.agent: ${opts.consumer}`);
        if (opts.project) tags.push(`consumer.project: ${opts.project}`);
        if (opts.noClaim !== undefined) tags.push(`consumer.no_claim: ${opts.noClaim}`);
        if (opts.role !== undefined) tags.push(`consumer.role: ${opts.role}`);
        if (hasDenyCode) tags.push("claude.deny_tools: file and shell tools");
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
    // Deliberately `aiball check` and not `claude-loop check`, including when
    // this ran as `claude-loop init` — the two answer different questions. This
    // one verifies what init just wrote (config, hooks, identity, daemon);
    // `claude-loop check` diagnoses what a loop's wake gate would do, and its
    // config half refuses without a loop name. Right after init there is no
    // loop, so pointing there would send the newcomer at a command that cannot
    // answer. Both binaries install together, so the cross-surface hint is safe.
    process.stdout.write(`Run \`aiball check\` to verify the config, hooks and daemon resolve.\n`);
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

/** #2180 — the tools `--deny-code` withholds: every way to read or change the
 *  disk. What remains is the aiball MCP surface, which never touches code. */
export const CODE_TOOLS = ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "NotebookEdit"] as const;

/** #2180 — the `claude:` block a fresh `.aiball.yaml` gets with `--deny-code`. */
export function denyCodeYamlBlock(): string {
    return `claude:\n  deny_tools: [${CODE_TOOLS.join(", ")}]\n`;
}

/** #2180 — set `claude.deny_tools` in an existing `.aiball.yaml`, keeping every
 *  other key and comment (yaml Document API, like patchIdentity). */
export function patchDenyTools(path: string): void {
    let doc;
    try {
        doc = parseDocument(readFileSync(path, "utf8"));
    } catch {
        die(`init: ${path} exists but isn't valid YAML — fix or remove it first`);
    }
    // #2180 — createNode: a plain `{}` is stored as a raw value with no `.set`, so
    // a file WITHOUT a claude block (the common case) died here.
    if (!doc.has("claude")) doc.set("claude", doc.createNode({}));
    const claude = doc.get("claude") as { set: (k: string, v: unknown) => void } | undefined;
    if (!claude || typeof (claude as { set?: unknown }).set !== "function") {
        die(`init: ${path} has a non-mapping 'claude' value — fix by hand, then re-run`);
    }
    claude.set("deny_tools", doc.createNode([...CODE_TOOLS], { flow: true }));
    writeFileSync(path, String(doc));
    process.stdout.write(`${path}: patched claude.deny_tools (${CODE_TOOLS.join(", ")})\n`);
}

export function patchIdentity(
    path: string,
    agent: string | undefined,
    project: string | undefined,
    noClaim: boolean | undefined,
    role: "lead" | "crew" | undefined,
): void {
    let doc;
    try {
        doc = parseDocument(readFileSync(path, "utf8"));
    } catch {
        die(`init: ${path} exists but isn't valid YAML — fix or remove it first`);
    }
    // #2180 — same trap as patchDenyTools: a plain `{}` has no `.set`.
    if (!doc.has("consumer")) doc.set("consumer", doc.createNode({}));
    const consumer = doc.get("consumer") as { set: (k: string, v: unknown) => void } | undefined;
    if (!consumer || typeof (consumer as { set?: unknown }).set !== "function") {
        die(`init: ${path} has a non-mapping 'consumer' value — fix by hand, then re-run`);
    }
    const changed: string[] = [];
    if (agent) { consumer.set("agent", agent); changed.push(`agent=${agent}`); }
    if (project) { consumer.set("project", project); changed.push(`project=${project}`); }
    if (noClaim !== undefined) { consumer.set("no_claim", noClaim); changed.push(`no_claim=${noClaim}`); }
    if (role !== undefined) { consumer.set("role", role); changed.push(`role=${role}`); }
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
 * #2090 — `aiball init gnome-extension`.
 *
 * Deliberately NOT the Windows tray. That one supervises the daemon because
 * Windows has no service manager for a user process; here `systemctl --user`
 * already does it. So the extension is visibility and shortcuts, and it talks
 * to the Unix socket rather than the port — which is what keeps any credential
 * out of a GNOME extension.
 *
 * A directory copy, unlike `init skill`'s single file, so a refresh REPLACES
 * the destination rather than merging into it: a stale `extension.js` left
 * behind by an older layout would be loaded by the shell alongside the new one.
 */
export const GNOME_EXTENSION_UUID = "aiball@quazardous.github.io";

export type GnomeExtensionVerdict =
    | { kind: "installed"; dest: string; src: string }
    | { kind: "skipped-exists"; dest: string }
    | { kind: "missing-source"; src: string };

/**
 * The copy itself, returning a VERDICT instead of dying — `die()` exits the
 * process, so the refusal to clobber is only observable from here. Mirrors
 * `copySkill` / `SkillInstallVerdict` next door.
 */
export function copyGnomeExtension(opts: { target?: string; force: boolean }): GnomeExtensionVerdict {
    const src = join(aiballInstallRoot(), "gnome", GNOME_EXTENSION_UUID);
    if (!existsSync(join(src, "metadata.json"))) return { kind: "missing-source", src };
    const destDir = opts.target ?? join(homedir(), ".local", "share", "gnome-shell", "extensions");
    const dest = join(destDir, GNOME_EXTENSION_UUID);
    if (existsSync(dest) && !opts.force) return { kind: "skipped-exists", dest };
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    cpSync(src, dest, { recursive: true });
    return { kind: "installed", dest, src };
}

export function installGnomeExtension(opts: { target?: string; force: boolean; enable?: boolean }): void {
    if (process.platform !== "linux" && opts.target === undefined) {
        die(`init gnome-extension: GNOME Shell extensions are a Linux thing (this is ${process.platform})`);
    }
    const v = copyGnomeExtension(opts);
    if (v.kind === "missing-source") {
        die(`init gnome-extension: source not found at ${v.src} — is the install root correct?`);
    }
    if (v.kind === "skipped-exists") {
        die(`init gnome-extension: ${v.dest} already exists — pass --overwrite to refresh`);
    }
    process.stdout.write(
        [
            `Installed the aiball GNOME extension → ${v.dest}`,
            ``,
            `Source: ${v.src}`,
            ...(opts.enable
                ? [
                    `Enabled — it shows in the top bar after your next GNOME login. A running`,
                    `Wayland shell does not load new extension code; on X11, Alt+F2 then "r" is enough.`,
                ]
                : [
                    `Enable it with:  aiball init gnome-extension --overwrite --enable`,
                    `(or gnome-extensions enable ${GNOME_EXTENSION_UUID})`,
                    ``,
                    `A running Wayland shell cannot rescan the extensions directory, so it only`,
                    `sees these files after you log out and back in. On X11, Alt+F2 then "r" is enough.`,
                ]),
            ``,
            `Then check:      gnome-extensions info ${GNOME_EXTENSION_UUID}   (expect State: ACTIVE)`,
            ``,
            `It reads the local Unix socket, so it carries no token. Re-run with`,
            `--overwrite to refresh after an aiball upgrade.`,
            ``,
        ].join("\n"),
    );
    if (opts.enable) enableGnomeExtension();
}

/**
 * #2251 — what an installer does about the extension. Offered, never installed
 * behind your back: an explicit choice wins; otherwise only on GNOME, asking in
 * a terminal and printing a hint when nobody can answer. An install that is
 * already there is refreshed, since someone chose it before.
 */
export type GnomeExtensionOffer = "declined" | "not-gnome" | "install" | "refresh" | "ask" | "hint";

export function gnomeExtensionOffer(o: {
    desktop?: string;
    hasCli: boolean;
    installed: boolean;
    choice?: boolean;
    interactive: boolean;
}): GnomeExtensionOffer {
    if (o.choice === false) return "declined";
    if (o.choice === true) return "install";
    const gnome = (o.desktop ?? "").split(":").some((d) => /gnome/i.test(d));
    if (!gnome || !o.hasCli) return "not-gnome";
    if (o.installed) return "refresh";
    return o.interactive ? "ask" : "hint";
}

/**
 * `gsettings get org.gnome.shell enabled-extensions` prints a GVariant string
 * array (`['a', 'b']`, or `@as []` when empty). Returns the value with `uuid`
 * appended, or null when it is already there.
 */
export function enabledExtensionsWith(current: string, uuid: string): string | null {
    const items = [...current.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
    if (items.includes(uuid)) return null;
    return `[${[...items, uuid].map((i) => `'${i}'`).join(", ")}]`;
}

/**
 * Enable the extension for the next login. `gnome-extensions enable` goes
 * through the running shell, which refuses an extension it has not loaded yet
 * — and a Wayland shell loads new ones only at login. The setting is what that
 * login reads, so make sure the uuid is in it either way.
 */
function enableGnomeExtension(): void {
    spawnSync("gnome-extensions", ["enable", GNOME_EXTENSION_UUID], { stdio: "ignore" });
    const get = spawnSync("gsettings", ["get", "org.gnome.shell", "enabled-extensions"], { encoding: "utf8" });
    if (get.status !== 0 || typeof get.stdout !== "string") return;
    const next = enabledExtensionsWith(get.stdout, GNOME_EXTENSION_UUID);
    if (next) spawnSync("gsettings", ["set", "org.gnome.shell", "enabled-extensions", next], { stdio: "ignore" });
}

/** The installers' gesture: `install.sh` and `aiball install --service` both end here. */
export async function offerGnomeExtension(o: { choice?: boolean } = {}): Promise<void> {
    if (process.platform !== "linux") return;
    const dest = join(homedir(), ".local", "share", "gnome-shell", "extensions", GNOME_EXTENSION_UUID);
    const verdict = gnomeExtensionOffer({
        desktop: process.env.XDG_CURRENT_DESKTOP,
        hasCli: spawnSync("gnome-extensions", ["version"], { stdio: "ignore" }).status === 0,
        installed: existsSync(dest),
        choice: o.choice,
        interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    });
    if (verdict === "declined" || verdict === "not-gnome") return;
    if (verdict === "hint") {
        process.stdout.write("GNOME detected — add aiball's top-bar indicator with: aiball init gnome-extension --enable\n");
        return;
    }
    if (verdict === "ask") {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question("Install the aiball GNOME top-bar extension? [Y/n] ")).trim().toLowerCase();
        rl.close();
        if (answer !== "" && !answer.startsWith("y")) {
            process.stdout.write("Skipped — add it later with: aiball init gnome-extension --enable\n");
            return;
        }
    }
    const v = copyGnomeExtension({ force: true });
    if (v.kind !== "installed") {
        process.stderr.write(`GNOME extension not installed: ${v.kind === "missing-source" ? `source not found at ${v.src}` : v.kind}\n`);
        return;
    }
    // A refresh leaves the enable state alone: someone may have switched it off.
    if (verdict !== "refresh") enableGnomeExtension();
    process.stdout.write(
        `${verdict === "refresh" ? "Refreshed" : "Installed and enabled"} the aiball GNOME extension → ${v.dest}\n` +
            "It shows the change after your next GNOME login — a running Wayland shell does not load new extension code.\n",
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
/**
 * #2074 — `aiball proxy pair`: ask the hub to be enrolled, instead of carrying
 * a 48-hex secret across two machines by hand.
 *
 * The node has no credential yet, so the request goes to the hub's public
 * enrolment route. It comes back with a short code, which this prints and a
 * human compares against the one shown in the aiball UI before approving —
 * that comparison is what ties the row they click to the machine you are
 * standing at. Nothing here can grant anything; it waits for a person.
 */
async function pairProxy(opts: { url: string; label?: string; strict?: boolean }): Promise<void> {
    const base = opts.url.replace(/\/+$/, "");
    const label = opts.label?.trim() || hostname();
    // #2081 — say what this machine is called, resolved by the same provider
    // chain a paired node uses in its WS hello (tailscale first, plain hostname
    // otherwise). The hub cannot work this out on its own: it sees the peer IP,
    // and a local reverse proxy turns that into 127.0.0.1 every time. The hub
    // stores it as a claim — this request has proved nothing yet.
    const dh = resolveDisplayHost();
    let req: { id: string; code: string; expires_at: string; ttl_seconds?: number };
    try {
        const res = await fetch(`${base}/api/nodes/enroll`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                label,
                display_host: dh?.host ?? null,
                display_host_provider: dh?.provider ?? null,
            }),
        });
        if (res.status === 403) {
            // #2074 — the window is shut. Say which of the two machines to go
            // to: a bare "refused" here costs ten minutes of looking at the
            // wrong one.
            return die(
                "proxy pair: the hub is not accepting pairing right now.\n"
                + "  Open aiball on the hub → Nodes → the \"Allow pairing\" button, then run this again.",
            );
        }
        if (!res.ok) die(`proxy pair: the hub refused the request (${res.status}) — ${await res.text()}`);
        req = await res.json() as typeof req;
    } catch (e) {
        return die(`proxy pair: cannot reach ${base} — ${(e as Error).message}`);
    }

    // #2083 — say HOW LONG, not at what o'clock: "how long do I have" is the
    // actual question, and a duration has no timezone to get wrong.
    // #2088 — the hub reports that duration, rather than us subtracting its
    // deadline from our own clock.
    const ttlMin = Math.max(1, Math.round((req.ttl_seconds ?? 600) / 60));
    const localAt = new Date(req.expires_at).toLocaleTimeString(undefined, {
        hour: "2-digit", minute: "2-digit",
    });
    // #2084 — write the request down BEFORE saying anything about it. From here
    // on this terminal is a convenience, not a requirement: if it is closed, or
    // the approval lands after the human has walked away, the node's own daemon
    // finishes the job on its next tick. The token is collectable once, and it
    // used to be collectable only by a process someone was still watching.
    savePairingRequest({
        url: base,
        id: req.id,
        code: req.code,
        expires_at: req.expires_at,
        strict: opts.strict === true,
        created_at: new Date().toISOString(),
    });

    process.stdout.write(
        `\n  Pairing code:  ${req.code}\n\n`
        + `  Open aiball on the hub, find this request under Nodes, check the code\n`
        + `  matches, and approve it. Waiting…  (expires in ${ttlMin} min, at ${localAt} on the hub)\n`
        + `  You can close this — the daemon on this machine will finish on its own.\n\n`,
    );

    // Poll until a human decides. Every second: this is someone clicking a
    // button, not a machine, so a slower interval only makes it feel broken.
    // The daemon polls the same request on its own timer; whichever gets there
    // first consumes the marker, and the other reads a settled state.
    // #2088 — give up after an ELAPSED wait, not at the hub's instant plus a
    // grace: that form was already past on the first tick of a node whose clock
    // ran ahead, so the command quit before polling once.
    const startedAt = Date.now();
    const giveUpAfterMs = (req.ttl_seconds ?? 600) * 1000 + 60_000;
    for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const r = await collectPendingPairing();
        if (r.kind === "waiting" || r.kind === "unreachable") {
            // A blip on the way to the hub is not a refusal.
            if (Date.now() - startedAt > giveUpAfterMs) {
                return die("proxy pair: gave up waiting — the daemon will keep trying, or run the command again.");
            }
            continue;
        }
        if (r.kind === "over") return die(`proxy pair: ${r.reason}. Run the command again to ask afresh.`);
        if (r.kind === "none" || r.kind === "already-configured") {
            // The daemon got there first — which is the point of the marker.
            process.stdout.write("  Approved and configured by the daemon on this machine.\n\n");
            return;
        }
        // #2084 — and finish the job. Telling someone standing right here to go
        // and type one more command was the third step david wanted gone.
        // Proxy mode is decided when the app is built, so it takes a restart.
        process.stdout.write(`  Approved → relaying to ${r.url}. Restarting the daemon…\n`);
        if (restartViaSupervisor()) {
            process.stdout.write("  Done. Check with:  aiball status\n\n");
        } else {
            process.stdout.write(
                `  The config is written, but the daemon could not restart itself:\n`
                + `  ${supervisorHint()}\n\n`,
            );
        }
        return;
    }
}

function initProxy(opts: { url: string; token: string; strict?: boolean }): void {
    // #2084 — the write itself lives in `proxy-config-write.ts`: the node's own
    // daemon performs the same one when it finishes a pairing, and two places
    // writing the same block would drift.
    let path: string;
    try {
        path = writeProxyConfig(opts);
    } catch (e) {
        return die(`proxy init: ${(e as Error).message}`);
    }

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


    // #2090: `aiball init gnome-extension` — deploy the shipped GJS extension
    // into ~/.local/share/gnome-shell/extensions/. Mirrors `init skill`: an
    // artefact that ships in the repo, copied into a user directory, refreshed
    // with --overwrite.
    initCmd
        .command("gnome-extension")
        .description("Install the aiball GNOME Shell extension into ~/.local/share/gnome-shell/extensions/")
        .option("--target <path>", "Explicit extensions directory (the extension lands at <path>/" + GNOME_EXTENSION_UUID + ")")
        .option("--overwrite", "Replace an existing install (a refresh REPLACES the directory, it does not merge)")
        .option("--enable", "Also enable it — recorded for your next GNOME login")
        .option("--offer", "What the installers run: only on GNOME, ask first (a hint when not in a terminal); refresh an existing install")
        .action(async (o: { target?: string; overwrite?: boolean; enable?: boolean; offer?: boolean }) => {
            if (o.offer) return offerGnomeExtension();
            installGnomeExtension({ target: o.target, force: o.overwrite === true, enable: o.enable === true });
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

    proxy
        .command("pair")
        .description("Ask the hub to enrol this node — a human approves it in the aiball UI (no token to copy)")
        .requiredOption("--url <url>", "Remote aiball URL to relay to (e.g. https://A-host:7777)")
        .option("--label <label>", "How this node names itself in the UI (default: hostname)")
        .option("--strict", "Never inject the node token: every relayed request must carry its own per-consumer bearer")
        .action(async (o: { url: string; label?: string; strict?: boolean }) => {
            await pairProxy({ url: o.url, label: o.label, strict: o.strict === true });
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
