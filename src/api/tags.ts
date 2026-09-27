/**
 * Tag CRUD + message-tag association routes (#B.213 phase 1.A).
 * Carved out of api.ts on 2026-05-19. No behavior change — handlers and
 * helper `resolveTagRef` moved verbatim, mounted as a sub-router from
 * the top-level api router.
 */
import { serveMethod } from "../bus/http.js";
import { Router } from "express";
import {
    getTag,
    getTagByName,
    listTags,
    type Tag,
} from "../db.js";
import { resolveConfigTags } from "../config-tags.js";

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

tagsRouter.post("/tags", serveMethod("tag.create", undefined, { status: 201 }));

tagsRouter.put("/tags/override", serveMethod("tag.override"));

tagsRouter.patch("/tags/:id", serveMethod("tag.update"));

tagsRouter.delete("/tags/:id", serveMethod("tag.delete", undefined, { status: 204, respond: (res) => { res.end(); } }));

tagsRouter.put("/messages/:id/tags", serveMethod("message.set_tags"));

tagsRouter.post("/messages/:id/tags", serveMethod("message.add_tag", undefined, { status: 201 }));

tagsRouter.delete("/messages/:id/tags/:tag", serveMethod("message.remove_tag"));
