/**
 * #2084 — writing the `proxy:` block, from either side.
 *
 * It used to live inside the CLI's `initProxy`, which is fine while a human is
 * the only one who ever configures a relay. Now the node's own daemon finishes
 * a pairing on its next tick, so the same write has two callers — and the
 * daemon cannot import a commander module to get at it.
 *
 * Document API rather than a re-serialise: the global config is hand-edited and
 * commented, and a pairing must not be the thing that eats someone's comments.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseDocument } from "yaml";
import { globalConfigPath } from "./autopoll/config.js";

export interface ProxyConfigWrite {
    url: string;
    token?: string;
    /** #394: never inject the node token — each request carries its own. */
    strict?: boolean;
}

/**
 * Set `proxy.url` / `proxy.token` / `proxy.strict` in the global config,
 * preserving everything else. Returns the path written.
 *
 * Throws on malformed YAML rather than overwriting it: a file we cannot parse
 * is a file someone wrote by hand, and replacing it would be the worst possible
 * answer.
 */
export function writeProxyConfig(opts: ProxyConfigWrite): string {
    const path = globalConfigPath();
    const doc = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "");
    if (doc.errors.length) {
        throw new Error(`${path} exists but isn't valid YAML — fix or remove it first`);
    }
    doc.setIn(["proxy", "url"], opts.url);
    if (opts.token) doc.setIn(["proxy", "token"], opts.token);
    if (opts.strict) doc.setIn(["proxy", "strict"], true);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, doc.toString(), "utf8");
    return path;
}
