import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const target = process.env.AIBALL_URL ?? "http://127.0.0.1:7777";
const wsTarget = target.replace(/^http/, "ws");

export default defineConfig({
    plugins: [vue()],
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
