/**
 * #2276 — the Signals tab: who holds a signal key, and what a project received.
 *
 * Moderator-only, like the Nodes panel. A key is addressed by its non-secret
 * `key_id`; the token value leaves the daemon once, in the answer to the POST
 * that minted it.
 */
import { Router, type Request, type Response } from "express";
import { isHuman } from "../db/consumers.js";
import {
    issueSignalKey,
    listProjectSignals,
    listSignalKeys,
    revokeSignalKey,
    updateSignalKeyNote,
} from "../db/signal-keys.js";
import { consumerOf, notFound } from "./_helpers.js";

export const signalKeysRouter = Router();

function moderatorOnly(req: Request, res: Response): boolean {
    if (isHuman(consumerOf(req))) return true;
    res.status(403).json({ error: "signal keys and received signals are moderator-only" });
    return false;
}

signalKeysRouter.get("/signal-keys", (req: Request, res: Response) => {
    if (!moderatorOnly(req, res)) return;
    const project = typeof req.query.project === "string" && req.query.project ? req.query.project : undefined;
    res.json(listSignalKeys(project));
});

signalKeysRouter.post("/signal-keys", (req: Request, res: Response) => {
    if (!moderatorOnly(req, res)) return;
    const r = issueSignalKey(req.body?.label, req.body?.note);
    if ("error" in r) return res.status(r.status).json({ error: r.error });
    res.status(201).json(r);
});

signalKeysRouter.patch("/signal-keys/:key_id", (req: Request, res: Response) => {
    if (!moderatorOnly(req, res)) return;
    const r = updateSignalKeyNote(String(req.params.key_id), req.body?.note);
    if ("error" in r) return res.status(r.status).json({ error: r.error });
    res.json(r);
});

signalKeysRouter.delete("/signal-keys/:key_id", (req: Request, res: Response) => {
    if (!moderatorOnly(req, res)) return;
    const key_id = String(req.params.key_id);
    if (!revokeSignalKey(key_id)) return notFound(res, "no signal key with this id");
    res.json({ key_id, revoked: true });
});

signalKeysRouter.get("/projects/:name/signals", (req: Request, res: Response) => {
    if (!moderatorOnly(req, res)) return;
    const project = String(req.params.name);
    res.json({ project, signals: listProjectSignals(project) });
});
