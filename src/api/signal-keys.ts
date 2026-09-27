/**
 * #2276 — the Signals tab: who holds a signal key, and what a project received.
 * Served by the bus methods in src/bus/methods/nodes.ts, all a moderator's. A
 * key is addressed by its non-secret `key_id`; the token value leaves the
 * daemon once, in the answer to the POST that minted it.
 */
import { Router } from "express";

export const signalKeysRouter = Router();






