/** #3063 — the board's catalogs (tags, milestones, who can be mentioned), and tagging a message. */
import { z } from "zod";
import { authorOf, defineMethod, Refusal } from "../methods.js";
import { id } from "../params.js";
import { addMessageTag, getTag, getTagByName, listMessageTags, listTags, removeMessageTag } from "../../db/tags.js";
import { getMessage } from "../../db.js";
import { broadcast } from "../../ws.js";
import { emitLifecycle } from "../../event-bus.js";
import { resolveTagRef, tagCatalog } from "../../api/tags.js";
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
