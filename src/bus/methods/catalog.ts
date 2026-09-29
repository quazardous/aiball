/** #3063 — the board's catalogs (tags, milestones, who can be mentioned), and tagging a message. */
import { z } from "zod";
import { authorOf, defineMethod, Refusal } from "../methods.js";
import { id } from "../params.js";
import { addMessageTag, deleteTag, getTag, getTagByName, insertTag, listMessageTags, listTags, removeMessageTag, setMessageTags, updateTag } from "../../db/tags.js";
import { configTagNames } from "../../config-tags.js";
import { getMessage } from "../../db.js";
import { broadcast } from "../../ws.js";
import { emitLifecycle } from "../../event-bus.js";
import { resolveTagRef, tagCatalog } from "../../queries/tag-catalog.js";
import { listMilestones } from "../../db/milestones.js";
import { listProjects } from "../../db/projects.js";
import { listKnownAgents } from "../../db/subscriptions.js";

/**
 * Without `project`, the database's tags (applied by numeric id). With it, the
 * merged catalog (config ⊕ database, each annotated with `source`); `_global`
 * or empty selects the cross-project view.
 */
defineMethod({
    name: "tag.list",
    who: ["human", "agent"],
    params: z.object({ project: z.string().optional() }),
    run: (_c, p) => {
        if (p.project === undefined) return listTags();
        return tagCatalog(p.project === "_global" || p.project === "" ? null : p.project);
    },
});

/** #2910 — a project's milestones, oldest first: state (open / released) and progress. */
defineMethod({
    name: "project.milestones",
    who: ["human", "agent"],
    params: z.object({ project: z.string() }),
    run: (_c, p) => {
        if (!p.project) throw new Refusal(400, "project required");
        return { project: p.project, milestones: listMilestones(p.project) };
    },
});

/** What the composer offers after `@`: projects and known agents. */
defineMethod({
    name: "mention.suggestions",
    who: ["human", "agent"],
    params: z.object({}),
    run: () => ({ projects: listProjects(), agents: listKnownAgents() }),
});

/**
 * Tag a message (idempotent: re-adding changes nothing). #457 — a tag new on
 * a ticket fires the `tagged` automation trigger. #3036 — `set_by` is the caller.
 */
defineMethod({
    name: "message.add_tag",
    who: ["human", "agent"],
    params: z.object({ id, tag: z.unknown().optional(), set_by: z.unknown().optional() }),
    run: (caller, p) => {
        const m = getMessage(p.id);
        if (!m) throw new Refusal(404, "not found");
        const t = resolveTagRef(p.tag);
        if (!t) throw new Refusal(400, `unknown tag: ${p.tag}`);
        const wasPresent = listMessageTags(p.id).some((x) => x.id === t.id);
        const setBy = authorOf(caller, p.set_by, "set_by");
        addMessageTag(p.id, t.id, setBy);
        const tags = listMessageTags(p.id);
        broadcast({ type: "message_tagged", data: { message_id: p.id, tags } });
        if (m.kind === "ticket_created" && !wasPresent) {
            emitLifecycle({ op: "tagged", message: m, added_tag: t.name, all_tags: tags.map((x) => x.name) });
        }
        return tags;
    },
});

/**
 * Replace a message's tags (`tag_ids`: tag ids or names). #457 — each tag new
 * on a ticket fires its own `tagged` trigger, as `match_tag_added` works per
 * tag. #3036 — `set_by` is the caller.
 */
defineMethod({
    name: "message.set_tags",
    who: ["human", "agent"],
    params: z.object({ id, tag_ids: z.unknown(), set_by: z.unknown().optional() }),
    run: (caller, p) => {
        const m = getMessage(p.id);
        if (!m) throw new Refusal(404, "not found");
        if (!Array.isArray(p.tag_ids)) throw new Refusal(400, "tag_ids must be an array of ids");
        const ids: number[] = [];
        for (const r of p.tag_ids) {
            const tag = typeof r === "number" ? getTag(r) : getTagByName(String(r));
            if (!tag) throw new Refusal(400, `unknown tag: ${r}`);
            ids.push(tag.id);
        }
        const before = new Set(listMessageTags(p.id).map((t) => t.name));
        const setBy = authorOf(caller, p.set_by, "set_by");
        setMessageTags(p.id, ids, setBy);
        const tags = listMessageTags(p.id);
        broadcast({ type: "message_tagged", data: { message_id: p.id, tags } });
        if (m.kind === "ticket_created") {
            const allNames = tags.map((t) => t.name);
            for (const t of tags) {
                if (!before.has(t.name)) emitLifecycle({ op: "tagged", message: m, added_tag: t.name, all_tags: allNames });
            }
        }
        return tags;
    },
});

/** Untag a message; `tag` is a tag id or name. */
defineMethod({
    name: "message.remove_tag",
    who: ["human", "agent"],
    params: z.object({ id, tag: z.string() }),
    run: (_c, p) => {
        if (!getMessage(p.id)) throw new Refusal(404, "not found");
        const t = /^\d+$/.test(p.tag) ? getTag(Number(p.tag)) : getTagByName(p.tag);
        if (!t) throw new Refusal(404, `unknown tag: ${p.tag}`);
        removeMessageTag(p.id, t.id);
        const tags = listMessageTags(p.id);
        broadcast({ type: "message_tagged", data: { message_id: p.id, tags } });
        return tags;
    },
});

const IN_CONFIG = (name: string) => new Refusal(409, `tag '${name}' is defined in config — edit the yaml, not the UI`);

/**
 * Create a tag, global or (#554) a project's (`_global` or empty is global):
 * two projects may each have a tag of the same name. A name the config
 * defines is the config's.
 */
defineMethod({
    name: "tag.create",
    who: ["human", "agent"],
    params: z.object({ name: z.unknown(), color: z.unknown().optional(), note: z.unknown().optional(), position: z.unknown().optional(), project: z.unknown().optional() }),
    run: (_c, p) => {
        if (typeof p.name !== "string" || !p.name.trim()) throw new Refusal(400, "name required");
        const name = p.name.trim();
        if (configTagNames().has(name)) throw IN_CONFIG(p.name);
        const scope = typeof p.project === "string" && p.project.trim() && p.project.trim() !== "_global" ? p.project.trim() : null;
        if (getTagByName(name, scope)) throw new Refusal(400, `tag '${p.name}' already exists${scope ? ` in project '${scope}'` : " (global)"}`);
        const t = insertTag({
            name,
            color: typeof p.color === "string" ? p.color : null,
            note: typeof p.note === "string" ? p.note : null,
            position: typeof p.position === "number" ? p.position : 0,
            project: scope,
        });
        broadcast({ type: "tag_changed", data: t });
        return t;
    },
});

/**
 * #223 — a config tag's color and order, set from the UI (its name stays the
 * config's): a row keyed by name, created or updated. A null color goes back
 * to the config's.
 */
defineMethod({
    name: "tag.override",
    who: ["human", "agent"],
    params: z.object({ name: z.unknown(), color: z.unknown().optional(), position: z.unknown().optional() }),
    run: (_c, p) => {
        if (typeof p.name !== "string" || !p.name.trim()) throw new Refusal(400, "name required");
        const name = p.name.trim();
        if (!configTagNames().has(name)) throw new Refusal(400, `'${name}' is not a config tag`);
        if (p.color !== undefined && p.color !== null && typeof p.color !== "string") throw new Refusal(400, "color must be a string or null");
        if (p.position !== undefined && typeof p.position !== "number") throw new Refusal(400, "position must be a number");
        const existing = getTagByName(name);
        const t = existing
            ? updateTag(existing.id, {
                color: p.color === undefined ? undefined : (p.color as string | null),
                position: p.position === undefined ? undefined : (p.position as number),
            })
            : insertTag({ name, color: typeof p.color === "string" ? p.color : null, position: typeof p.position === "number" ? p.position : 0 });
        broadcast({ type: "tag_changed", data: t });
        return t;
    },
});

/** Change a database tag; a config tag, or a name the config holds, is refused. */
defineMethod({
    name: "tag.update",
    who: ["human", "agent"],
    params: z.object({ id, name: z.unknown().optional(), color: z.unknown().optional(), note: z.unknown().optional(), position: z.unknown().optional() }),
    run: (_c, p) => {
        if (p.name !== undefined && (typeof p.name !== "string" || !p.name.trim())) throw new Refusal(400, "name must be a non-empty string");
        const existing = getTag(p.id);
        const configNames = configTagNames();
        if (existing && configNames.has(existing.name)) throw IN_CONFIG(existing.name);
        if (typeof p.name === "string" && configNames.has(p.name.trim())) throw IN_CONFIG(p.name);
        if (typeof p.name === "string") {
            const dup = getTagByName(p.name.trim());
            if (dup && dup.id !== p.id) throw new Refusal(400, `tag '${p.name}' already exists`);
        }
        const updated = updateTag(p.id, {
            name: typeof p.name === "string" ? p.name.trim() : undefined,
            color: p.color === null || typeof p.color === "string" ? p.color : undefined,
            note: p.note === null || typeof p.note === "string" ? p.note : undefined,
            position: typeof p.position === "number" ? p.position : undefined,
        });
        if (!updated) throw new Refusal(404, "not found");
        broadcast({ type: "tag_changed", data: updated });
        return updated;
    },
});

/** Delete a database tag; a config tag is refused. */
defineMethod({
    name: "tag.delete",
    who: ["human", "agent"],
    params: z.object({ id }),
    run: (_c, p) => {
        const existing = getTag(p.id);
        if (!existing) throw new Refusal(404, "not found");
        if (configTagNames().has(existing.name)) throw IN_CONFIG(existing.name);
        deleteTag(p.id);
        broadcast({ type: "tag_changed", data: { id: p.id, deleted: true } });
        return { id: p.id, deleted: true };
    },
});
