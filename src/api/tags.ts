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
import { configTagNames, resolveConfigTags } from "../config-tags.js";
import { badRequest, conflict, notFound } from "./_helpers.js";

export const tagsRouter = Router();

function resolveTagRef(ref: unknown): Tag | null {
    if (typeof ref === "number") return getTag(ref);
    if (typeof ref === "string") {
        return getTagByName(ref) ?? null;
    }
    return null;
}

/**
 * Read-model row for the merged catalog (#223). DB tags keep their id and
 * report `source:"db"`. Config tags report `source:"config"` — their NAME
 * is config-owned (non-renamable, non-deletable), but their color + order
 * are overridable from the UI (#223 zcjqgp): when a matching DB row exists
 * its color/position WIN over the config default, `id` is exposed so the
 * frontend can render it, and `color_overridden` flags the divergence so
 * the override is visible. A DB tag whose name is also a config tag is
 * folded into the config row (never shown twice).
 */
interface CatalogTag {
    id: number | null;
    name: string;
    color: string | null;
    note: string | null;
    position: number;
    source: "config" | "db";
    created_at: string | null;
    /** Config tags only: the config-default color the override diverges from. */
    config_color?: string | null;
    /** Config tags only: true when a DB row overrides the config color. */
    color_overridden?: boolean;
}

export function tagCatalog(project: string | null): CatalogTag[] {
    const config = resolveConfigTags(project);
    const dbByName = new Map(listTags().map((t) => [t.name, t] as const));
    const out: CatalogTag[] = config.map((t, i) => {
        const row = dbByName.get(t.name);
        return {
            id: row?.id ?? null,
            name: t.name,
            color: row?.color ?? t.color, // DB override wins (#223 zcjqgp)
            note: t.note, // note stays config-sourced
            position: row?.position ?? i,
            source: "config" as const,
            created_at: row?.created_at ?? null,
            config_color: t.color,
            color_overridden: !!row && row.color != null && row.color !== t.color,
        };
    });
    const configNames = new Set(config.map((t) => t.name));
    for (const t of listTags()) {
        if (configNames.has(t.name)) continue;
        out.push({ ...t, source: "db" });
    }
    out.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    return out;
}

// `GET /tags` (no param) stays DB-only — the TagPicker applies tags by
// numeric id and would choke on config tags' null id. The merged catalog
// (config ⊕ DB, each annotated with `source`) is opt-in via `?project=`,
// where `_global` / empty selects the cross-project view (project=null).
tagsRouter.get("/tags", (req: Request, res: Response) => {
    const raw = req.query.project;
    if (typeof raw !== "string") {
        return res.json(listTags());
    }
    const project = raw === "_global" || raw === "" ? null : raw;
    res.json(tagCatalog(project));
});

tagsRouter.post("/tags", (req: Request, res: Response) => {
    const { name, color, note, position } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
        return badRequest(res, "name required");
    }
    if (configTagNames().has(name.trim())) {
        return conflict(res, `tag '${name}' is defined in config — edit the yaml, not the UI`);
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

// Config-tag override (#223 zcjqgp). A config tag's NAME is immutable
// (the PATCH/DELETE-by-id endpoints stay 409 on config names), but its
// color + order ARE editable from the UI. The override persists as a DB
// row keyed by NAME — upserted here. `color: null` resets to the config
// default (the catalog falls back to the config color). DB-source tags
// keep using PATCH /tags/:id; this is the config-tag write path.
tagsRouter.put("/tags/override", (req: Request, res: Response) => {
    const { name, color, position } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
        return badRequest(res, "name required");
    }
    const tagName = name.trim();
    if (!configTagNames().has(tagName)) {
        return badRequest(res, `'${tagName}' is not a config tag`);
    }
    if (color !== undefined && color !== null && typeof color !== "string") {
        return badRequest(res, "color must be a string or null");
    }
    if (position !== undefined && typeof position !== "number") {
        return badRequest(res, "position must be a number");
    }
    const existing = getTagByName(tagName);
    const t = existing
        ? updateTag(existing.id, {
            color: color === undefined ? undefined : color,
            position: position === undefined ? undefined : position,
        })
        : insertTag({
            name: tagName,
            color: typeof color === "string" ? color : null,
            position: typeof position === "number" ? position : 0,
        });
    broadcast({ type: "tag_changed", data: t });
    res.json(t);
});

tagsRouter.patch("/tags/:id", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const { name, color, note, position } = req.body ?? {};
    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
        return badRequest(res, "name must be a non-empty string");
    }
    const existing = getTag(id);
    const configNames = configTagNames();
    if (existing && configNames.has(existing.name)) {
        return conflict(res, `tag '${existing.name}' is defined in config — edit the yaml, not the UI`);
    }
    if (typeof name === "string" && configNames.has(name.trim())) {
        return conflict(res, `tag '${name}' is defined in config — edit the yaml, not the UI`);
    }
    if (typeof name === "string") {
        const dup = getTagByName(name.trim());
        if (dup && dup.id !== id) {
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
    const existing = getTag(id);
    if (!existing) return notFound(res);
    if (configTagNames().has(existing.name)) {
        return conflict(res, `tag '${existing.name}' is defined in config — edit the yaml, not the UI`);
    }
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
