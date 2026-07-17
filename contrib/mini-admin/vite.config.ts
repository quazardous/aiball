import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// The UI kit is not a published package — it lives in the aiball frontend and
// is reached by path. `@kit` keeps that reach in ONE place instead of spreading
// `../../../frontend/src/components/ui/…` through every component.
const kit = fileURLToPath(new URL("../../frontend/src/components/ui", import.meta.url));
const frontend = fileURLToPath(new URL("../../frontend/src", import.meta.url));

export default defineConfig({
    plugins: [vue()],
    resolve: {
        alias: {
            "@kit": kit,
            "@frontend": frontend,
        },
    },
    server: {
        fs: {
            // Vite denies imports outside its root by default; the kit lives
            // above it (../../frontend), so the repo root must be allowed.
            allow: [fileURLToPath(new URL("../..", import.meta.url))],
        },
    },
});
