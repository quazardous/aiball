/**
 * #3256 — the settings of a project a client may show and change without
 * touching the folder itself: read and patched in the `.aiball.yaml` a loop
 * started in that folder reads (the nearest one, up the tree), so what a
 * client sets is what the next start gets. Patched in place: the file's other
 * keys and its comments stay. A short list, each key a typed field, never a
 * free key/value: first `claude.remote_control`.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { findConfigUpwards, loadConfig } from "./autopoll/config.js";
import { parseRemoteControl, type RemoteControl } from "./claude-loop/remote-control.js";
import { InitRefusal } from "./project-init.js";

/** What a folder's loops start with, and whether its file says so or it is the default. */
export interface ProjectSettings {
    /** The `.aiball.yaml` a loop in this folder reads; null when there is none. */
    file: string | null;
    remote_control: { value: RemoteControl; from: "file" | "default" };
}

/** The changes a client may make; `null` removes the key, and the default applies again. */
export interface SettingsPatch {
    remote_control?: RemoteControl | null;
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
    const inFile = file ? parseRemoteControl(readDoc(file).getIn(["claude", "remote_control"])) : null;
    return {
        file,
        remote_control: { value: loadConfig(cwd).claude.remote_control, from: inFile !== null ? "file" : "default" },
    };
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
    if (patch.remote_control !== undefined) {
        const claude = doc.get("claude");
        if (claude !== undefined && claude !== null && typeof (claude as { set?: unknown }).set !== "function") {
            throw new InitRefusal(409, "CONFLICT", `${file} has a non-mapping 'claude' value — fix it by hand first`);
        }
        if (patch.remote_control === null) {
            doc.deleteIn(["claude", "remote_control"]);
            // An emptied `claude:` block says nothing: drop it rather than leave `claude: {}`.
            const left = doc.get("claude") as { items?: unknown[] } | undefined;
            if (left && Array.isArray(left.items) && left.items.length === 0) doc.delete("claude");
        } else {
            if (claude === undefined || claude === null) doc.set("claude", doc.createNode({}));
            doc.setIn(["claude", "remote_control"], patch.remote_control);
        }
    }
    try {
        writeFileSync(file, String(doc));
    } catch (e) {
        throw new InitRefusal(403, "FORBIDDEN", `cannot write ${file}: ${(e as Error).message}`);
    }
    return readSettings(cwd);
}
