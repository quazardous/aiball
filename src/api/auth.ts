/**
 * Bootstrap + session auth routes (#B.94, carved out of api.ts in
 * #B.213 phase 1.E on 2026-05-19). Behavior-preserving move.
 *
 * Endpoints:
 *   GET  /auth/status   — public probe (frontend uses it to decide
 *                          first-boot vs login mode)
 *   POST /auth/setup    — consume install token, create first human
 *   POST /auth/login    — login+password → auth token
 *   POST /auth/logout   — revoke the token used to call
 *   GET  /me            — current consumer (closely tied to auth
 *                          identity resolution; lives here for
 *                          colocation)
 *
 * Bearer auth middleware (`bearerAuth`) is NOT mounted from here —
 * api.ts still installs it as the first global middleware, so every
 * route on every sub-router gets req.consumer_id set.
 */
import { Router, type Request, type Response } from "express";
import {
    anyHumanCredentials,
    deleteToken,
    getConsumer,
    getPasswordHash,
    getToken,
    issueToken,
    listTokens,
    setPasswordHash,
    touchLastLogin,
    upsertConsumer,
    type TokenKind,
} from "../db.js";
import { hashPassword, verifyPassword } from "../auth.js";
import { badRequest, consumerOf } from "./_helpers.js";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIBALL_HOME } from "../paths.js";

export const authRouter = Router();

/**
 * GET /api/auth/status — public probe. Tells the frontend whether the
 * daemon needs an install token (first boot, no humans yet) or is in
 * normal "login required" mode.
 */
authRouter.get("/auth/status", (req, res) => {
    const ready = anyHumanCredentials();
    const hasInstall = listTokens({ kind: "install" }).length > 0;
    const tokenStr = (() => {
        const a = req.header("authorization");
        if (a && /^bearer\s+/i.test(a)) return a.replace(/^bearer\s+/i, "").trim();
        return req.header("x-aiball-token") ?? null;
    })();
    let me: { consumer_id: string; kind: TokenKind } | null = null;
    if (typeof tokenStr === "string" && tokenStr) {
        const t = getToken(tokenStr);
        if (t && t.kind !== "install" && t.consumer_id) {
            me = { consumer_id: t.consumer_id, kind: t.kind };
        }
    }
    res.json({
        ready,
        // True whenever a usable install token exists in the DB. Decoupled
        // from `ready` so that `aiball auth reinit` (which mints a fresh
        // install token even when humans already exist) reopens the
        // /setup path. The frontend uses this to decide whether to show
        // the setup form at all.
        install_available: hasInstall,
        me,
    });
});

/**
 * POST /api/auth/setup — consume the bootstrap install token to create
 * the first human consumer. Body: {token, consumer_id, password,
 * display_name?}.
 */
authRouter.post("/auth/setup", async (req: Request, res: Response) => {
    const { token, consumer_id, password, display_name } = (req.body ?? {}) as {
        token?: unknown;
        consumer_id?: unknown;
        password?: unknown;
        display_name?: unknown;
    };
    if (typeof token !== "string" || !token) {
        return badRequest(res, "install token required");
    }
    if (typeof consumer_id !== "string" || !consumer_id || consumer_id.length > 64) {
        return badRequest(res, "consumer_id required (1-64 chars)");
    }
    if (!/^[A-Za-z0-9._-]+$/.test(consumer_id)) {
        return badRequest(res, "consumer_id must contain only A-Za-z0-9._-");
    }
    if (typeof password !== "string" || password.length < 6) {
        return badRequest(res, "password required (min 6 chars)");
    }
    const installRow = getToken(token);
    if (!installRow || installRow.kind !== "install") {
        return res.status(401).json({ error: "invalid install token" });
    }
    // A valid install token is proof of CLI access (only `aiball auth
    // init/reinit` mints one). CLI access already grants full power
    // over the DB, so we allow overwriting an existing human's
    // password — this is exactly what `aiball auth reinit` is for.
    const hash = await hashPassword(password);
    upsertConsumer({
        consumer_id,
        kind: "human",
        display_name: typeof display_name === "string" && display_name ? display_name : null,
        enabled: true,
    });
    setPasswordHash(consumer_id, hash);
    touchLastLogin(consumer_id);
    deleteToken(token);
    const auth = issueToken({ consumer_id, kind: "auth", label: "web setup" });

    // Auto-write cli-env so the CLI/MCP/claude-loop running in the
    // same user context (typical local install) get a working agent
    // token without a manual `aiball auth issue` + paste-to-file
    // step. Idempotent: if cli-env already exists we don't touch
    // it — respects users who manage their own. -System / LocalSystem
    // installs write to PROGRAMDATA where per-user shims don't look, so
    // the user still does the manual workflow there (WIN-INSTALL.md).
    try {
        const cliEnv = join(AIBALL_HOME, "cli-env");
        if (!existsSync(cliEnv)) {
            const agent = issueToken({ consumer_id, kind: "agent", label: "cli (auto-issued at first setup)" });
            writeFileSync(cliEnv, `export AIBALL_TOKEN=${agent.token}\n`, { mode: 0o600 });
        }
    } catch {
        // Non-fatal — the user can always issue + write manually.
    }

    res.json({
        token: auth.token,
        consumer_id,
    });
});

/**
 * POST /api/auth/login — exchange login+password for an auth token.
 * Body: {consumer_id, password}. Returns {token, consumer_id} on success.
 */
authRouter.post("/auth/login", async (req: Request, res: Response) => {
    const { consumer_id, password } = (req.body ?? {}) as {
        consumer_id?: unknown;
        password?: unknown;
    };
    if (typeof consumer_id !== "string" || !consumer_id) {
        return badRequest(res, "consumer_id required");
    }
    if (typeof password !== "string") {
        return badRequest(res, "password required");
    }
    const c = getConsumer(consumer_id);
    if (!c || !c.enabled || c.kind !== "human") {
        // Same response shape on failure to avoid revealing enumeration.
        return res.status(401).json({ error: "invalid credentials" });
    }
    const hash = getPasswordHash(consumer_id);
    if (!hash) return res.status(401).json({ error: "invalid credentials" });
    const ok = await verifyPassword(password, hash);
    if (!ok) return res.status(401).json({ error: "invalid credentials" });
    touchLastLogin(consumer_id);
    const auth = issueToken({ consumer_id, kind: "auth", label: "web login" });
    res.json({
        token: auth.token,
        consumer_id,
    });
});

/**
 * POST /api/auth/logout — revoke the token used to authenticate.
 * Idempotent: succeeds even if the token is already gone.
 */
authRouter.post("/auth/logout", (req: Request, res: Response) => {
    const a = req.header("authorization");
    let token: string | null = null;
    if (a && /^bearer\s+/i.test(a)) token = a.replace(/^bearer\s+/i, "").trim();
    if (!token) token = req.header("x-aiball-token") ?? null;
    if (token) deleteToken(token);
    res.json({ ok: true });
});

/**
 * GET /api/me — current authenticated consumer + display info. Useful
 * for the frontend to render "Hello, David" without an extra lookup.
 */
authRouter.get("/me", (req: Request, res: Response) => {
    const id = consumerOf(req);
    const c = getConsumer(id);
    if (!c) return res.status(404).json({ error: "consumer not found" });
    res.json(c);
});
