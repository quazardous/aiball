/**
 * Tag CRUD + message-tag association routes (#B.213 phase 1.A).
 * Carved out of api.ts on 2026-05-19. No behavior change — handlers and
 * helper `resolveTagRef` moved verbatim, mounted as a sub-router from
 * the top-level api router.
 */
import { Router, type Request, type Response } from "express";
import {
    addMessageTag,
    deleteTag,
    getMessage,
    getTag,
    getTagByName,
    insertTag,
    listMessageTags,
    listTags,
    removeMessageTag,
    setMessageTags,
    updateTag,
    type Tag,
} from "../db.js";
import { broadcast } from "../ws.js";
import { badRequest, notFound } from "./_helpers.js";

export const tagsRouter = Router();

function resolveTagRef(ref: unknown): Tag | null {
    if (typeof ref === "number") return getTag(ref);
    if (typeof ref === "string") {
        return getTagByName(ref) ?? null;
    }
    return null;
}

tagsRouter.get("/tags", (_req, res) => {
    res.json(listTags());
});

tagsRouter.post("/tags", (req: Request, res: Response) => {
    const { name, color, note, position } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
        return badRequest(res, "name required");
    }
    if (getTagByName(name.trim())) {
        return badRequest(res, `tag '${name}' already exists`);
    }
    const t = insertTag({
        name: name.trim(),
        color: typeof color === "string" ? color : null,
        note: typeof note === "string" ? note : null,
        position: typeof position === "number" ? position : 0,
    });
    broadcast({ type: "tag_changed", data: t });
    res.status(201).json(t);
});

tagsRouter.patch("/tags/:id", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const { name, color, note, position } = req.body ?? {};
    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
        return badRequest(res, "name must be a non-empty string");
    }
    if (typeof name === "string") {
        const conflict = getTagByName(name.trim());
        if (conflict && conflict.id !== id) {
            return badRequest(res, `tag '${name}' already exists`);
        }
    }
    const updated = updateTag(id, {
        name: typeof name === "string" ? name.trim() : undefined,
        color: color === null || typeof color === "string" ? color : undefined,
        note: note === null || typeof note === "string" ? note : undefined,
        position: typeof position === "number" ? position : undefined,
    });
    if (!updated) return notFound(res);
    broadcast({ type: "tag_changed", data: updated });
    res.json(updated);
});

tagsRouter.delete("/tags/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!getTag(id)) return notFound(res);
    deleteTag(id);
    broadcast({ type: "tag_changed", data: { id, deleted: true } });
    res.status(204).end();
});

tagsRouter.get("/messages/:id/tags", (req, res) => {
    const id = Number(req.params.id);
    if (!getMessage(id)) return notFound(res);
    res.json(listMessageTags(id));
});

tagsRouter.put("/messages/:id/tags", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const m = getMessage(id);
    if (!m) return notFound(res);
    const { tag_ids, set_by } = req.body ?? {};
    if (!Array.isArray(tag_ids)) {
        return badRequest(res, "tag_ids must be an array of ids");
    }
    const ids: number[] = [];
    for (const r of tag_ids) {
        const tag = typeof r === "number" ? getTag(r) : getTagByName(String(r));
        if (!tag) return badRequest(res, `unknown tag: ${r}`);
        ids.push(tag.id);
    }
    setMessageTags(id, ids, typeof set_by === "string" ? set_by : null);
    const tags = listMessageTags(id);
    broadcast({ type: "message_tagged", data: { message_id: id, tags } });
    res.json(tags);
});

tagsRouter.post("/messages/:id/tags", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const m = getMessage(id);
    if (!m) return notFound(res);
    const { tag, set_by } = req.body ?? {};
    const t = resolveTagRef(tag);
    if (!t) return badRequest(res, `unknown tag: ${tag}`);
    addMessageTag(id, t.id, typeof set_by === "string" ? set_by : null);
    const tags = listMessageTags(id);
    broadcast({ type: "message_tagged", data: { message_id: id, tags } });
    res.status(201).json(tags);
});

tagsRouter.delete("/messages/:id/tags/:tag", (req, res) => {
    const id = Number(req.params.id);
    const m = getMessage(id);
    if (!m) return notFound(res);
    const tagRef = req.params.tag;
    const t =
        /^\d+$/.test(tagRef) ? getTag(Number(tagRef)) : getTagByName(tagRef);
    if (!t) return notFound(res, `unknown tag: ${tagRef}`);
    removeMessageTag(id, t.id);
    const tags = listMessageTags(id);
    broadcast({ type: "message_tagged", data: { message_id: id, tags } });
    res.json(tags);
});
