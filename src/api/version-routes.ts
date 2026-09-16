/**
 * #2586 — `GET /api/version` and `POST /api/version/check`.
 *
 * Public, like `/api/node`: the tray and the GNOME extension hold no token. They
 * reveal what `/api/health` already does (the version) plus the latest release
 * and the install MODE — never the source path nor the update command, which
 * the clients build from the local `install.json` they can read themselves.
 * Mounted before the proxy relay: a proxy node reports its OWN version.
 */
import type express from "express";
import { AIBALL_VERSION } from "../version.js";
import { getConfig } from "../db/config-overrides.js";
import { readInstallInfo } from "../install-info.js";
import { readInstalledVersion, runUpdateCheck, updateCheckState, versionView } from "../update-check.js";

export function updateCheckEnabled(): boolean {
    try {
        return getConfig("updates.check") !== false;
    } catch {
        return true; // no DB (proxy boot before open): the default
    }
}

function view() {
    return { ...versionView(AIBALL_VERSION, readInstalledVersion(), updateCheckState(), !updateCheckEnabled()), mode: readInstallInfo().mode };
}

export function mountVersionRoutes(app: express.Express): void {
    app.get("/api/version", (_req, res) => res.json(view()));
    app.post("/api/version/check", async (_req, res) => {
        if (updateCheckEnabled()) await runUpdateCheck(fetch);
        res.json(view());
    });
}

/** Daemon boot: one check in the background, unless turned off. */
export function checkForUpdatesAtBoot(): void {
    if (updateCheckEnabled()) void runUpdateCheck(fetch);
}
