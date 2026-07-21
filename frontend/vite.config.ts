import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const target = process.env.AIBALL_URL ?? "http://127.0.0.1:7777";
const wsTarget = target.replace(/^http/, "ws");

// #190 — RELATIVE asset base so a SINGLE build runs under ANY mount path
// (root `/`, `/aiball`, `/xyz/…`) with no rebuild. Assets emit as `./assets/…`
// and resolve against wherever index.html was served ; the app discovers its
// real base at runtime from the bundle URL (lib/base.ts) and routes via the
// hash (`/xyz/#/b/981`) so the served path stays the base regardless of route.

// Single source of truth: the repo-root package.json (qcmp `aiball`
// component). Injected as a compile-time constant so the UI footer can
// show `aiball v<x.y.z>` without a runtime fetch.
const aiballVersion: string = (() => {
    try {
        const pkg = JSON.parse(
            readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ) as { version?: unknown };
        return typeof pkg.version === "string" ? pkg.version : "0.0.0";
    } catch {
        return "0.0.0";
    }
})();

export default defineConfig({
    base: "./",
    plugins: [vue()],
    define: {
        __AIBALL_VERSION__: JSON.stringify(aiballVersion),
    },
    // Don't follow symlinks when resolving modules / entry html. Without
    // this, dev installs of aiball that symlink the install dir to the
    // source checkout (Windows `install.ps1 -Symlink`, or any equivalent)
    // make Rollup see `../../../../../dev/aiball/frontend/index.html` as
    // the entry, which it rejects (relative paths not allowed for
    // emitted file names). #B.178 follow-up.
    resolve: {
        preserveSymlinks: true,
        // #B.122 — the frontend shares the daemon's business enums instead of
        // hand-mirroring them: `@shared` points at the repo-root `src/` so
        // `lib/domain.ts` can re-export `src/domain.ts` (single source, no drift).
        alias: {
            "@shared": fileURLToPath(new URL("../src", import.meta.url)),
        },
    },
    server: {
        port: 5173,
        proxy: {
            "/api": { target, changeOrigin: true },
            "/ws": { target: wsTarget, ws: true, changeOrigin: true },
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
    },
});
