/**
 * #3256 — the settings of a project a client may show and change without
 * touching the folder itself: read and patched in the `.aiball.yaml` a loop
 * started in that folder reads (the nearest one, up the tree), so what a
 * client sets is what the next start gets. Patched in place: the file's other
 * keys and its comments stay. A short list, each key a typed field, never a
 * free key/value: first `claude.remote_control`.
 *
 * #3305 — the folder's resolved configuration too, for a client that sets a
 * folder up (tvty's new-project assistant) to start from what is there: the
 * identity a loop there takes and where it runs, each value with where it
 * comes from (`from`), so what is not the default can be shown as such.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { findConfigUpwards, globalConfigPath, loadConfig, parseLoopSession, readGlobalLoopSession, type ConsumerRole, type ConsumerSource, type LoopSession } from "./autopoll/config.js";
import { parseRemoteControl, type RemoteControl } from "./claude-loop/remote-control.js";
import { InitRefusal } from "./project-init.js";

/** What a folder's loops start with, and whether its file says so or it is the default. */
export interface ProjectSettings {
    /** The `.aiball.yaml` a loop in this folder reads; null when there is none. */
    file: string | null;
    /** #3305 — a `.aiball.yaml` applies to this folder (its own, or one up the tree). */
    configured: boolean;
    /** #3305 — the identity a loop started here takes. `env`: the daemon's own environment says so. */
    consumer: {
        project: { value: string; from: IdentityFrom };
        agent: { value: string; from: IdentityFrom };
        role: { value: ConsumerRole | null; from: "file" | "default" };
    };
    /** #3305 — where a loop started here runs: the file's, the machine's (global config), or the default. */
    session: { value: LoopSession; from: "file" | "global" | "default" };
    remote_control: { value: RemoteControl; from: "file" | "default" };
}

/** Where an identity value comes from: the folder's file, the legacy `.mcp.json`, the environment, or the default. */
export type IdentityFrom = "file" | "mcp" | "env" | "default";

const IDENTITY_FROM: Record<ConsumerSource, IdentityFrom> = { "aiball.yaml": "file", "mcp.json": "mcp", env: "env", default: "default" };

/** The changes a client may make; `null` removes the key, and the layer below applies again. */
export interface SettingsPatch {
    remote_control?: RemoteControl | null;
    /** #3305 — `claude_loop.session`. */
    session?: LoopSession | null;
}

type Doc = ReturnType<typeof parseDocument>;

function checkFolder(cwd: string): void {
    let isDir = false;
    try { isDir = statSync(cwd).isDirectory(); } catch { /* absent */ }
    if (!isDir) throw new InitRefusal(404, "NOT_FOUND", `no such folder: ${cwd}`);
}

function readDoc(file: string): Doc {
    let text: string;
    try {
        text = readFileSync(file, "utf8");
    } catch (e) {
        throw new InitRefusal(403, "FORBIDDEN", `cannot read ${file}: ${(e as Error).message}`);
    }
    const doc = parseDocument(text);
    if (doc.errors.length > 0) throw new InitRefusal(409, "CONFLICT", `${file} isn't valid YAML — fix it by hand first`);
    return doc;
}

/** The settings a loop started in `cwd` would get. Throws `InitRefusal`. */
export function readSettings(cwd: string): ProjectSettings {
    checkFolder(cwd);
    const file = findConfigUpwards(cwd);
    const doc = file ? readDoc(file) : null;
    const inFile = doc ? parseRemoteControl(doc.getIn(["claude", "remote_control"])) : null;
    const cfg = loadConfig(cwd);
    const sessionInFile = doc ? parseLoopSession(doc.getIn(["claude_loop", "session"])) : undefined;
    const roleInFile = doc ? doc.getIn(["consumer", "role"]) : undefined;
    return {
        file,
        configured: file !== null,
        consumer: {
            project: { value: cfg.consumer.project!, from: IDENTITY_FROM[cfg.consumer.project_source ?? "default"] },
            agent: { value: cfg.consumer.agent!, from: IDENTITY_FROM[cfg.consumer.agent_source ?? "default"] },
            role: { value: cfg.consumer.role, from: roleInFile !== undefined && roleInFile !== null && cfg.consumer.role !== null ? "file" : "default" },
        },
        session: {
            value: cfg.claude_loop.session,
            from: sessionInFile !== undefined ? "file" : readGlobalLoopSession(globalConfigPath()) !== undefined ? "global" : "default",
        },
        remote_control: { value: cfg.claude.remote_control, from: inFile !== null ? "file" : "default" },
    };
}

/** Set `path` (a key under one block) to `value`, or remove it with null; an emptied block goes too. */
function patchKey(doc: Doc, file: string, block: string, key: string, value: unknown): void {
    const node = doc.get(block);
    if (node !== undefined && node !== null && typeof (node as { set?: unknown }).set !== "function") {
        throw new InitRefusal(409, "CONFLICT", `${file} has a non-mapping '${block}' value — fix it by hand first`);
    }
    if (value === null) {
        doc.deleteIn([block, key]);
        // An emptied block says nothing: drop it rather than leave `block: {}`.
        const left = doc.get(block) as { items?: unknown[] } | undefined;
        if (left && Array.isArray(left.items) && left.items.length === 0) doc.delete(block);
    } else {
        if (node === undefined || node === null) doc.set(block, doc.createNode({}));
        doc.setIn([block, key], value);
    }
}

/**
 * Patch the settings of the file a loop in `cwd` reads, and answer them as
 * they now are. A folder without one is refused: writing a new file there
 * would hide a parent's whole configuration. Throws `InitRefusal`.
 */
export function writeSettings(cwd: string, patch: SettingsPatch): ProjectSettings {
    checkFolder(cwd);
    const file = findConfigUpwards(cwd);
    if (!file) throw new InitRefusal(409, "CONFLICT", `no .aiball.yaml in ${cwd} or above: set the folder up first (project.init)`);
    const doc = readDoc(file);
    if (patch.remote_control !== undefined) patchKey(doc, file, "claude", "remote_control", patch.remote_control);
    if (patch.session !== undefined) patchKey(doc, file, "claude_loop", "session", patch.session);
    try {
        writeFileSync(file, String(doc));
    } catch (e) {
        throw new InitRefusal(403, "FORBIDDEN", `cannot write ${file}: ${(e as Error).message}`);
    }
    return readSettings(cwd);
}
