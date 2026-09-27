/**
 * Per-consumer read-state routes (#B.213 phase 1.D).
 * Carved out of api.ts on 2026-05-19 — behavior-preserving move.
 *
 * #3067 — the routes are the HTTP face of the read-state methods
 * (src/bus/methods/read-state.ts), kept while a client still calls them.
 */
import { Router } from "express";

export const readTrackingRouter = Router();







