/**
 * #3208 — setting a folder up as a project: its `.mcp.json` (the aiball MCP
 * server) and its `.aiball.yaml` (who the agent is, and in which project).
 * The one body behind `aiball init`, `claude-loop init` and the bus's
 * `project.init`: it writes in the folder it is given and says what it did, as
 * steps a caller prints or returns, never on stdout. A folder that cannot be
 * read or written, or a file there that cannot be parsed, is an
 * `InitRefusal` with a code, not a message on the terminal.
 *
 * It touches the folder only: the skill in `~/.claude`, the project on the
 * board, a rename (`--migrate-from`) are the callers' gestures.
 */
import { accessSync, constants, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseDocument } from "yaml";
import { loadConfig } from "./autopoll/config.js";

/** A project or agent name: what the board accepts in a path or a file name. */
export const NAME_RE = /^[a-zA-Z0-9_.-]+$/;

/** The tools `--deny-code` withholds: every way to read or change the disk. */
export const CODE_TOOLS = ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "NotebookEdit"] as const;

/** The `claude:` block a fresh `.aiball.yaml` gets with `denyCode`. */
export function denyCodeYamlBlock(): string {
    return `claude:\n  deny_tools: [${CODE_TOOLS.join(", ")}]\n`;
}

export interface ProjectInitInput {
    cwd: string;
    agent?: string;
    project?: string;
    noClaim?: boolean;
    role?: "lead" | "crew";
    private?: boolean;
    denyCode?: boolean;
    force?: boolean;
    /** Say what would be done, write nothing. */
    dryRun?: boolean;
}

/** One file's fate: what happened (or would), and the line a terminal prints for it. */
export interface InitStep {
    file: ".mcp.json" | ".aiball.yaml";
    action: "created" | "added" | "rewritten" | "patched" | "overwrote" | "kept";
    message: string;
}

/** Why a folder was not set up: the HTTP status and code a client reacts on. */
export class InitRefusal extends Error {
    constructor(readonly status: 400 | 403 | 404 | 409, readonly code: "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT", message: string) {
        super(message);
    }
}

/**
 * #3312 — a crew agent set up without a name of its own would take the
 * folder's default, `<project>-claude`: the lead's name. Its loop would then
 * speak as the lead, from another machine. So a crew with no agent named,
 * here or in the folder's config, is named `<project>-crew`.
 */
function crewNamed(input: ProjectInitInput): ProjectInitInput {
    if (input.role !== "crew" || input.agent) return input;
    let cfg: ReturnType<typeof loadConfig> | null = null;
    try { cfg = loadConfig(input.cwd); } catch { /* unreadable: the defaults */ }
    if (cfg && cfg.consumer.agent_source !== "default") return input;
    const project = input.project ?? cfg?.consumer.project ?? basename(input.cwd);
    return { ...input, agent: `${project}-crew` };
}

/** Set the folder up; the steps, in order. Throws `InitRefusal`. */
export function initFolder(input: ProjectInitInput): InitStep[] {
    const { cwd } = input;
    for (const [what, v] of [["project", input.project], ["agent", input.agent]] as const) {
        if (v !== undefined && !NAME_RE.test(v)) throw new InitRefusal(400, "BAD_REQUEST", `invalid ${what} name '${v}': letters, digits, '_', '.' and '-' only`);
    }
    if (input.role !== undefined && input.role !== "lead" && input.role !== "crew") {
        throw new InitRefusal(400, "BAD_REQUEST", `role must be 'lead' or 'crew' (got '${String(input.role)}')`);
    }
    let isDir = false;
    try { isDir = statSync(cwd).isDirectory(); } catch { /* absent */ }
    if (!isDir) throw new InitRefusal(404, "NOT_FOUND", `no such folder: ${cwd}`);
    input = crewNamed(input);
    try {
        accessSync(cwd, constants.W_OK);
    } catch {
        throw new InitRefusal(403, "FORBIDDEN", `cannot write in ${cwd}`);
    }
    const write = (path: string, text: string) => {
        if (input.dryRun) return;
        try {
            writeFileSync(path, text);
        } catch (e) {
            throw new InitRefusal(403, "FORBIDDEN", `cannot write ${path}: ${(e as Error).message}`);
        }
    };
    return [mcpStep(input, write), ...yamlSteps(input, write)];
}

function mcpStep(input: ProjectInitInput, write: (path: string, text: string) => void): InitStep {
    const path = join(input.cwd, ".mcp.json");
    type McpFile = { mcpServers?: Record<string, unknown> };
    let json: McpFile = { mcpServers: {} };
    const existed = existsSync(path);
    if (existed) {
        try {
            json = JSON.parse(readFileSync(path, "utf8")) as McpFile;
        } catch {
            throw new InitRefusal(409, "CONFLICT", `${path} exists but is invalid JSON — fix it by hand, then re-run`);
        }
        if (!json.mcpServers || typeof json.mcpServers !== "object") json.mcpServers = {};
    }
    const servers = json.mcpServers as Record<string, unknown>;
    const had = "aiball" in servers;
    if (had && !input.force) {
        return { file: ".mcp.json", action: "kept", message: `${path}: aiball entry already present — re-run with --force to overwrite (drops legacy env block)` };
    }
    servers.aiball = { command: "aiball-mcp" };
    write(path, JSON.stringify(json, null, 2) + "\n");
    if (!existed) return { file: ".mcp.json", action: "created", message: `created ${path} with the aiball MCP entry` };
    if (!had) return { file: ".mcp.json", action: "added", message: `${path}: added aiball MCP entry (other servers preserved)` };
    return { file: ".mcp.json", action: "rewritten", message: `${path}: aiball entry rewritten to canonical form (legacy env block dropped if any)` };
}

function yamlSteps(input: ProjectInitInput, write: (path: string, text: string) => void): InitStep[] {
    const yamlPath = join(input.cwd, ".aiball.yaml");
    const yamlExists = existsSync(yamlPath);
    const hasIdentity = !!input.agent || !!input.project || input.noClaim !== undefined || input.role !== undefined;
    const hasProjectType = input.private === true;
    const hasDenyCode = input.denyCode === true;
    if (yamlExists && !input.force) {
        // An existing file is patched, never rewritten: its other keys and its
        // comments stay; a field is touched only when it is asked for.
        const steps: InitStep[] = [];
        if (hasIdentity) steps.push(patchIdentityStep(yamlPath, input, write));
        if (hasProjectType) steps.push(patchProjectTypeStep(yamlPath, "private", write));
        if (hasDenyCode) steps.push(patchDenyToolsStep(yamlPath, write));
        if (steps.length === 0) steps.push({ file: ".aiball.yaml", action: "kept", message: `${yamlPath}: already exists — re-run with --force to overwrite` });
        return steps;
    }
    const consumerLines = hasIdentity
        ? "consumer:\n"
            + (input.agent ? `  agent: ${input.agent}\n` : "")
            + (input.project ? `  project: ${input.project}\n` : "")
            + (input.noClaim !== undefined ? `  no_claim: ${input.noClaim}\n` : "")
            + (input.role !== undefined ? `  role: ${input.role}\n` : "")
        : "";
    write(yamlPath,
        "# Bootstrapped by `aiball init`. See .aiball.yaml.example for the full annotated template.\n"
        + (input.private === true ? "project_type: private\n" : "")
        + consumerLines
        + (hasDenyCode ? denyCodeYamlBlock() : "")
        + "autopoll:\n"
        + "  enabled: true\n");
    const tags: string[] = ["autopoll enabled"];
    if (input.private === true) tags.push("project_type: private");
    if (input.agent) tags.push(`consumer.agent: ${input.agent}`);
    if (input.project) tags.push(`consumer.project: ${input.project}`);
    if (input.noClaim !== undefined) tags.push(`consumer.no_claim: ${input.noClaim}`);
    if (input.role !== undefined) tags.push(`consumer.role: ${input.role}`);
    if (hasDenyCode) tags.push("claude.deny_tools: file and shell tools");
    const overwrote = yamlExists && input.force === true;
    return [{ file: ".aiball.yaml", action: overwrote ? "overwrote" : "created", message: `${overwrote ? "overwrote" : "created"} ${yamlPath} (${tags.join(", ")})` }];
}

type Doc = ReturnType<typeof parseDocument>;
type Mapping = { set: (k: string, v: unknown) => void };

function readDoc(path: string): Doc {
    try {
        return parseDocument(readFileSync(path, "utf8"));
    } catch {
        throw new InitRefusal(409, "CONFLICT", `init: ${path} exists but isn't valid YAML — fix or remove it first`);
    }
}

/** The mapping at `key`, created when absent; a non-mapping value is refused. */
function mappingAt(doc: Doc, key: string, path: string): Mapping {
    // A plain `{}` has no `.set`: createNode builds a real mapping.
    if (!doc.has(key)) doc.set(key, doc.createNode({}));
    const node = doc.get(key) as Mapping | undefined;
    if (!node || typeof (node as { set?: unknown }).set !== "function") {
        throw new InitRefusal(409, "CONFLICT", `init: ${path} has a non-mapping '${key}' value — fix by hand, then re-run`);
    }
    return node;
}

/** Set `consumer.agent` / `project` / `no_claim` / `role` in an existing `.aiball.yaml`. */
export function patchIdentityStep(path: string, input: Pick<ProjectInitInput, "agent" | "project" | "noClaim" | "role">, write: (path: string, text: string) => void = writeFileSync): InitStep {
    const doc = readDoc(path);
    const consumer = mappingAt(doc, "consumer", path);
    const changed: string[] = [];
    if (input.agent) { consumer.set("agent", input.agent); changed.push(`agent=${input.agent}`); }
    if (input.project) { consumer.set("project", input.project); changed.push(`project=${input.project}`); }
    if (input.noClaim !== undefined) { consumer.set("no_claim", input.noClaim); changed.push(`no_claim=${input.noClaim}`); }
    if (input.role !== undefined) { consumer.set("role", input.role); changed.push(`role=${input.role}`); }
    write(path, String(doc));
    return { file: ".aiball.yaml", action: "patched", message: `${path}: patched consumer (${changed.join(", ")})` };
}

/** Set the top-level `project_type:` in an existing `.aiball.yaml`; nothing written when it already is. */
export function patchProjectTypeStep(path: string, value: string, write: (path: string, text: string) => void = writeFileSync): InitStep {
    const doc = readDoc(path);
    const prev = doc.get("project_type");
    if (prev === value) return { file: ".aiball.yaml", action: "kept", message: `${path}: project_type already '${value}' (no change)` };
    doc.set("project_type", value);
    write(path, String(doc));
    return { file: ".aiball.yaml", action: "patched", message: `${path}: patched project_type='${value}'${prev ? ` (was '${prev}')` : ""}` };
}

/** Set `claude.deny_tools` in an existing `.aiball.yaml`. */
export function patchDenyToolsStep(path: string, write: (path: string, text: string) => void = writeFileSync): InitStep {
    const doc = readDoc(path);
    const claude = mappingAt(doc, "claude", path);
    claude.set("deny_tools", doc.createNode([...CODE_TOOLS], { flow: true }));
    write(path, String(doc));
    return { file: ".aiball.yaml", action: "patched", message: `${path}: patched claude.deny_tools (${CODE_TOOLS.join(", ")})` };
}
