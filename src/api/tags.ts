/**
 * Tag CRUD + message-tag association routes (#B.213 phase 1.A).
 * Carved out of api.ts on 2026-05-19. No behavior change — handlers and
 * helper `resolveTagRef` moved verbatim, mounted as a sub-router from
 * the top-level api router.
 */
import { serveMethod } from "../bus/http.js";
import { Router, type Request, type Response } from "express";
import {
    deleteTag,
    getMessage,
    getTag,
    getTagByName,
    insertTag,
    listMessageTags,
    listTags,
    updateTag,
    type Tag,
} from "../db.js";
import { broadcast } from "../ws.js";
import { configTagNames, resolveConfigTags } from "../config-tags.js";
import { badRequest, conflict, notFound } from "./_helpers.js";

export const tagsRouter = Router();

export function resolveTagRef(ref: unknown): Tag | null {
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
    /** #554 — `null` for global tags and config rows (config is
     *  inherently cross-project) ; project name for scoped tags. */
    project?: string | null;
}

export function tagCatalog(project: string | null): CatalogTag[] {
    const config = resolveConfigTags(project);
    // #554 — fold global DB tags (project IS NULL) into the catalog
    // always, AND any tag scoped to the requested project (when not
    // global view). A tag with the same name in both buckets : the
    // project-scoped row wins (more specific). The config-override
    // matcher (DB row by NAME) consults the global bucket first since
    // config tags themselves are cross-project.
    const globalRows = listTags(null);
    const projectRows = project !== null ? listTags(project) : [];
    const dbByName = new Map<string, ReturnType<typeof listTags>[number]>();
    for (const t of globalRows) dbByName.set(t.name, t);
    for (const t of projectRows) dbByName.set(t.name, t);   // project wins
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
    for (const t of [...globalRows, ...projectRows]) {
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
tagsRouter.get("/tags", serveMethod("tag.list"));

tagsRouter.post("/tags", (req: Request, res: Response) => {
    const { name, color, note, position, project } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
        return badRequest(res, "name required");
    }
    if (configTagNames().has(name.trim())) {
        return conflict(res, `tag '${name}' is defined in config — edit the yaml, not the UI`);
    }
    // #554 — accept `project` from the body. Empty string / "_global"
    // / undefined → global tag (project=null). Otherwise scope to that
    // project. The composite UNIQUE (name, project) ensures two projects
    // can each have a `win` tag without clashing.
    const projectScope = typeof project === "string" && project.trim() && project.trim() !== "_global"
        ? project.trim()
        : null;
    if (getTagByName(name.trim(), projectScope)) {
        return badRequest(res, `tag '${name}' already exists${projectScope ? ` in project '${projectScope}'` : " (global)"}`);
    }
    const t = insertTag({
        name: name.trim(),
        color: typeof color === "string" ? color : null,
        note: typeof note === "string" ? note : null,
        position: typeof position === "number" ? position : 0,
        project: projectScope,
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

tagsRouter.put("/messages/:id/tags", serveMethod("message.set_tags"));

tagsRouter.post("/messages/:id/tags", serveMethod("message.add_tag", undefined, { status: 201 }));

tagsRouter.delete("/messages/:id/tags/:tag", serveMethod("message.remove_tag"));
