import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The aiball version — single source of truth is the repo-root
 * `package.json` (the same field qcmp.yaml tracks as the `aiball`
 * component). Read once at module load. Surfaced via `aiball --version`,
 * `GET /api/health`, and the web UI footer (injected at build time).
 */
export const AIBALL_VERSION: string = (() => {
    try {
        // src/version.ts → up 1 = repo root.
        const here = dirname(fileURLToPath(import.meta.url));
        const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
            version?: unknown;
        };
        return typeof pkg.version === "string" ? pkg.version : "0.0.0";
    } catch {
        return "0.0.0";
    }
})();
