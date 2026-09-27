/**
 * #2276 — the Signals tab: who holds a signal key, and what a project received.
 * Served by the bus methods in src/bus/methods/nodes.ts, all a moderator's. A
 * key is addressed by its non-secret `key_id`; the token value leaves the
 * daemon once, in the answer to the POST that minted it.
 */
import { Router } from "express";
import { serveMethod } from "../bus/http.js";

export const signalKeysRouter = Router();

signalKeysRouter.get("/signal-keys", serveMethod("signal_key.list"));
signalKeysRouter.post("/signal-keys", serveMethod("signal_key.create", undefined, { status: 201 }));
signalKeysRouter.patch("/signal-keys/:key_id", serveMethod("signal_key.update"));
signalKeysRouter.delete("/signal-keys/:key_id", serveMethod("signal_key.revoke"));
signalKeysRouter.get("/projects/:name/signals", serveMethod("project.signals"));
