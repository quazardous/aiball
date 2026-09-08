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
import { Router, type Request, type Response } from "express";
import { badRequest, consumerOf, notFound } from "./_helpers.js";
import { getMessage } from "../db.js";
import { isTicketClosed } from "../db/messages.js";
import { isHuman } from "../db/consumers.js";
import {
    readTicketPayload,
    readTicketPayloadRaw,
    revokeTicketPayload,
    writeTicketPayload,
} from "../db/payloads.js";
import { canReadPayloadSecrets, payloadAccessState } from "../db/ticket-payload.js";

export const payloadsRouter = Router();

type TicketRow = {
    id: number;
    kind: string;
    by_agent?: string | null;
    assignee?: string | null;
};

/** Resolve the ticket, or answer for it. */
function ticketOr404(req: Request, res: Response): TicketRow | null {
    const id = Number(req.params.id);
    const t = getMessage(id) as TicketRow | undefined;
    if (!t || t.kind !== "ticket_created") {
        notFound(res, "ticket not found");
        return null;
    }
    return t;
}

/**
 * The gate — owner / assignee / reporter, and deliberately not the claimant.
 *
 * See `canReadPayloadSecrets` for why: claim is self-service, so honouring it
 * would let any agent open the vault by claiming the ticket first.
 */
function guardSecretAccess(req: Request, res: Response, t: TicketRow): boolean {
    const caller = consumerOf(req);
    if (canReadPayloadSecrets(t, caller, isHuman(caller))) return true;
    res.status(403).json({
        error: "only the reporter, the assignee or a moderator can reach this payload's values",
    });
    return false;
}

/**
 * The filtered view. Not gated beyond reading the ticket itself: by
 * construction it carries no secret, and its whole purpose is that a payload
 * stays auditable — visible in shape — to people who cannot read it.
 */
payloadsRouter.get("/tickets/:id/payload", (req: Request, res: Response) => {
    const t = ticketOr404(req, res);
    if (!t) return;
    const view = readTicketPayload(t.id);
    if (!view) return notFound(res, "this ticket carries no payload");
    res.json({ ...view, access: payloadAccessState({ closed: isTicketClosed(t.id) }, view) });
});

/** Deposit or replace. */
payloadsRouter.put("/tickets/:id/payload", (req: Request, res: Response) => {
    const t = ticketOr404(req, res);
    if (!t) return;
    if (!guardSecretAccess(req, res, t)) return;
    if (isTicketClosed(t.id)) {
        return badRequest(res, "this ticket is closed — reopen it before depositing a payload");
    }
    const body = req.body ?? {};
    const payload: unknown = body.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return badRequest(res, "`payload` must be a JSON object of key -> value");
    }
    // `schema` names the PUBLIC keys. Absent means none of them, which is the
    // safe default — see db/ticket-payload.ts.
    const rawSchema: unknown = body.schema;
    if (rawSchema !== undefined && rawSchema !== null) {
        if (!Array.isArray(rawSchema) || rawSchema.some((k) => typeof k !== "string")) {
            return badRequest(res, "`schema` must be an array of key names that are public");
        }
        const unknownKeys = (rawSchema as string[]).filter(
            (k) => !Object.prototype.hasOwnProperty.call(payload, k),
        );
        if (unknownKeys.length > 0) {
            // Declaring a key public that isn't in the payload is almost always
            // a typo — and a typo here silently keeps a value secret that the
            // author believed they had published, or the reverse on the next
            // deposit. Cheap to catch, expensive to debug.
            return badRequest(res, `schema names keys absent from the payload: ${unknownKeys.join(", ")}`);
        }
    }
    const view = writeTicketPayload(
        t.id,
        payload as Record<string, unknown>,
        (rawSchema as string[] | null | undefined) ?? [],
        consumerOf(req),
    );
    res.json({ ...view, access: payloadAccessState({ closed: isTicketClosed(t.id) }, view) });
});

/**
 * The deliberate dump — the only path to the values.
 *
 * Closing the ticket ends access: the payload's lifetime is the work's
 * lifetime. Reopening restores it; revoking does not (there is nothing left).
 */
payloadsRouter.post("/tickets/:id/payload/dump", (req: Request, res: Response) => {
    const t = ticketOr404(req, res);
    if (!t) return;
    if (!guardSecretAccess(req, res, t)) return;
    const view = readTicketPayload(t.id);
    if (!view) return notFound(res, "this ticket carries no payload");
    const access = payloadAccessState({ closed: isTicketClosed(t.id) }, view);
    if (access === "revoked") {
        return res.status(410).json({ error: "this payload was revoked — its values are gone", access });
    }
    if (access === "ticket-closed") {
        return res.status(409).json({
            error: "this ticket is closed — reopen it to reach the payload",
            access,
        });
    }
    const values = readTicketPayloadRaw(t.id);
    if (!values) return notFound(res, "this ticket carries no payload");
    res.json({ ticket_id: t.id, payload: values, access });
});

/** Revoke: destroy the values, keep the trace that they existed. */
payloadsRouter.delete("/tickets/:id/payload", (req: Request, res: Response) => {
    const t = ticketOr404(req, res);
    if (!t) return;
    if (!guardSecretAccess(req, res, t)) return;
    const view = revokeTicketPayload(t.id, consumerOf(req));
    if (!view) return notFound(res, "this ticket carries no payload");
    res.json({ ...view, access: payloadAccessState({ closed: isTicketClosed(t.id) }, view) });
});
