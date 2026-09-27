/**
 * #2109 — the payload zone's HTTP surface.
 *
 * Four routes, and the split between them is the design:
 *
 *   GET    /api/tickets/:id/payload        the filtered view — keys always,
 *                                          values only where the schema says
 *   PUT    /api/tickets/:id/payload        deposit / replace
 *   POST   /api/tickets/:id/payload/dump   the values themselves, deliberately
 *   DELETE /api/tickets/:id/payload        revoke (destroy values, keep trace)
 *
 * The dump is a POST rather than a GET on purpose: a secret should not be
 * reachable by a URL that proxies log, browsers keep in history, and people
 * paste into tickets. It is also the only route wired to
 * `readTicketPayloadRaw()`.
 */
import { Router } from "express";

// #3067 — the payload methods (src/bus/methods/misc.ts) hold the rules.
export const payloadsRouter = Router();





