/**
 * #394 volet A: a per-project LOCAL remote config for claude-loop. Written by
 * `claude-loop init`, read by `claude-loop start` so a plain `start` reconnects
 * to the same REMOTE aiball without re-passing flags. Lives at
 * `<cwd>/.aiball.local.yaml` and is git-ignored — it carries a bearer token.
 *
 * Kept SEPARATE from `.aiball.yaml` (the committed russian-doll config) on
 * purpose: a secret must never land in a versioned file. Only the loop's
 * init/start touch it; the general config layer ignores it.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";

export interface LocalRemote {
    url?: string;
    token?: string;
    consumer?: string;
    project?: string;
}

const FILE = ".aiball.local.yaml";

export function localConfigPath(cwd: string): string {
    return join(cwd, FILE);
}

/** Read the `remote:` block from `<cwd>/.aiball.local.yaml`. Null when absent,
 *  unparsable, or missing a url. */
export function readLocalRemote(cwd: string): LocalRemote | null {
    const p = localConfigPath(cwd);
    if (!existsSync(p)) return null;
    try {
        const raw = (parseYaml(readFileSync(p, "utf8")) ?? {}) as { remote?: Record<string, unknown> };
        const r = raw.remote;
        if (!r || typeof r !== "object") return null;
        const pick = (k: string) =>
            typeof r[k] === "string" && (r[k] as string).trim() ? (r[k] as string).trim() : undefined;
        const out: LocalRemote = {
            url: pick("url"),
            token: pick("token"),
            consumer: pick("consumer"),
            project: pick("project"),
        };
        return out.url ? out : null;
    } catch {
        return null;
    }
}

/** Write/merge the `remote:` block into `<cwd>/.aiball.local.yaml` (chmod 600,
 *  preserving any existing keys/comments). Returns the path. */
export function writeLocalRemote(cwd: string, remote: LocalRemote): string {
    const p = localConfigPath(cwd);
    let doc;
    try {
        doc = parseDocument(existsSync(p) ? readFileSync(p, "utf8") : "");
    } catch {
        throw new Error(`${p} exists but isn't valid YAML — fix or remove it first`);
    }
    for (const k of ["url", "token", "consumer", "project"] as const) {
        if (remote[k]) doc.setIn(["remote", k], remote[k]);
    }
    writeFileSync(p, doc.toString(), "utf8");
    try {
        chmodSync(p, 0o600); // it carries a token
    } catch {
        /* best effort (e.g. Windows) */
    }
    return p;
}
