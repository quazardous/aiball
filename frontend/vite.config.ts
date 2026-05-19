import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const target = process.env.AIBALL_URL ?? "http://127.0.0.1:7777";
const wsTarget = target.replace(/^http/, "ws");

export default defineConfig({
    plugins: [vue()],
    // Don't follow symlinks when resolving modules / entry html. Without
    // this, dev installs of aiball that symlink the install dir to the
    // source checkout (Windows `install.ps1 -Symlink`, or any equivalent)
    // make Rollup see `../../../../../dev/aiball/frontend/index.html` as
    // the entry, which it rejects (relative paths not allowed for
    // emitted file names). #B.178 follow-up.
    resolve: { preserveSymlinks: true },
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
