/**
 * #2910 david — "comment lier des tickets rapidement à un milestone ? … la
 * commande c'est bien": `aiball --human ticket milestone <milestone> <ids…>`.
 *
 * Pure: reads the arguments and resolves the milestone against the project's
 * list; the command does the I/O.
 */

/** What the first argument names: a milestone by id, by version, or none. */
export type MilestoneArg = { kind: "id"; id: number } | { kind: "title"; title: string } | { kind: "none" };

/** `#2932` or `2932` → an id; `none` → out of any milestone; anything else → a version. */
export function parseMilestoneArg(raw: string): MilestoneArg {
    const s = raw.trim();
    if (s.toLowerCase() === "none") return { kind: "none" };
    const m = /^#?(\d+)$/.exec(s);
    // A bare version like `3` is ambiguous with an id; `#3` / `2932` read as ids,
    // and a version with a dot (`0.3`) never looks like one.
    if (m) return { kind: "id", id: Number(m[1]) };
    return { kind: "title", title: s };
}

/** The ticket ids: `2929 #2930 2931,2932`. Refuses anything that is not one. */
export function parseTicketIds(raw: readonly string[]): number[] | { error: string } {
    const out: number[] = [];
    for (const tok of raw.flatMap((r) => r.split(/[\s,]+/)).filter(Boolean)) {
        const m = /^#?(\d+)$/.exec(tok);
        if (!m) return { error: `"${tok}" is not a ticket id` };
        const id = Number(m[1]);
        if (!out.includes(id)) out.push(id);
    }
    if (out.length === 0) return { error: "no ticket to put in the milestone" };
    return out;
}

/** The open milestones of the project, as `milestone_list` gives them. */
export interface MilestoneChoice {
    id: number;
    title: string;
    released: boolean;
}

/** The milestone id to set (null = none), or why the version names none or several. */
export function resolveMilestone(arg: MilestoneArg, milestones: readonly MilestoneChoice[]): number | null | { error: string } {
    if (arg.kind === "none") return null;
    if (arg.kind === "id") return arg.id;
    const open = milestones.filter((m) => !m.released);
    const hits = open.filter((m) => m.title === arg.title);
    if (hits.length === 1) return hits[0].id;
    if (hits.length > 1) {
        return { error: `several open milestones are named "${arg.title}": ${hits.map((m) => `#${m.id}`).join(", ")} — name one by its id` };
    }
    const names = open.map((m) => `${m.title} (#${m.id})`).join(", ");
    return { error: `no open milestone named "${arg.title}"${names ? `; open ones: ${names}` : "; this project has no open milestone"}` };
}
