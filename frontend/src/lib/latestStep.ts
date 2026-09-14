/**
 * #2470 david — "en cas de then:continue multiple seul le dernier compte ; en
 * UI il faut afficher que le dernier". A step is superseded by the next one:
 * the backlog and the inbox row already read only the latest. The thread marked
 * every step with its chip and resume time, so a resume that had long passed
 * sat next to the one that counts.
 */
import { isStepMeta } from "../../../src/ticket-transitions";

/** The id of the thread's latest step comment, or null when there is none. */
export function latestStepId(comments: ReadonlyArray<{ id: number; kind: string; meta?: string | null }>): number | null {
    let latest: number | null = null;
    for (const c of comments) {
        if (c.kind !== "comment_added" || !isStepMeta(c.meta ?? null)) continue;
        if (latest === null || c.id > latest) latest = c.id;
    }
    return latest;
}
