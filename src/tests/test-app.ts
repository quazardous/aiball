/**
 * #3068 — the app a test builds: the daemon's, plus the HTTP routes that
 * served bus methods (`legacy-routes.ts`), which production no longer mounts.
 */
import { api } from "../api.js";
import { createApp } from "../app.js";
import { legacyRoutes } from "./legacy-routes.js";

let mounted = false;

export function createTestApp(): ReturnType<typeof createApp> {
    if (!mounted) {
        api.use(legacyRoutes);
        mounted = true;
    }
    return createApp();
}
