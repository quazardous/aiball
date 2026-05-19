/**
 * Project subscription CRUD (#B.213 phase 1.D).
 * Carved out of api.ts on 2026-05-19 — behavior-preserving move.
 *
 * Note: the legacy section in api.ts labeled "subscriptions" mixed in
 * read-tracking routes (/unread, /mark-read) which aren't really
 * subscriptions — those moved to ./api/read-tracking.ts. This file
 * is just the subscriptions table CRUD.
 */
import { Router, type Request, type Response } from "express";
import {
    deleteSubscription,
    listSubscriptions,
    upsertSubscription,
} from "../db.js";
import { badRequest } from "./_helpers.js";

export const subscriptionsRouter = Router();

subscriptionsRouter.post("/subscriptions", (req: Request, res: Response) => {
    const { consumer_id, project, role } = req.body ?? {};
    if (typeof consumer_id !== "string" || !consumer_id) {
        return badRequest(res, "consumer_id required");
    }
    if (typeof project !== "string" || !project) {
        return badRequest(res, "project required");
    }
    let roleArg: "owner" | "follower" | undefined;
    if (role !== undefined && role !== null) {
        if (role !== "owner" && role !== "follower") {
            return badRequest(res, "role must be 'owner' or 'follower'");
        }
        roleArg = role;
    }
    const sub = upsertSubscription(consumer_id, project, roleArg);
    res.status(201).json(sub);
});

subscriptionsRouter.get("/subscriptions", (req: Request, res: Response) => {
    const consumer_id = req.query.consumer_id as string | undefined;
    res.json(listSubscriptions(consumer_id));
});

subscriptionsRouter.delete("/subscriptions", (req: Request, res: Response) => {
    const { consumer_id, project } = req.query;
    if (typeof consumer_id !== "string" || typeof project !== "string") {
        return badRequest(res, "consumer_id and project query params required");
    }
    deleteSubscription(consumer_id, project);
    res.status(204).end();
});
