import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

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

/**
 * #505 david `mwm67f` — short git commit of the deployed checkout, read once
 * at module load. Surfaced to the proxy WS handshake so server logs can spot
 * a graphite (or any node) running outdated code vs the upstream. "no-git"
 * when the binary runs outside a git tree (e.g. shipped tarball).
 */
export const AIBALL_COMMIT: string = (() => {
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        const root = join(here, "..");
        const sha = execSync("git rev-parse --short HEAD", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return sha.trim() || "no-git";
    } catch {
        return "no-git";
    }
})();
