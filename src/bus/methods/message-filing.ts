/**
 * What filing a message needs besides the bus method (`message.post`, in
 * src/bus/methods/message.ts): the platform tag of a new ticket, and the HTTP
 * status of each submit refusal. No route: the ones this file held moved to
 * the bus (#3063, #3068).
 */
import { addMessageTag, getTagByName, insertTag } from "../../db/tags.js";
import { platformTagName } from "../../db/platform-tag.js";


/**
 * #2099 — stamp the filing machine's platform on a new ticket.
 *
 * Applied here rather than in the MCP tool so it cannot be forgotten by a
 * client: the CLI, the MCP and anything else that files a ticket go through
 * `message.post`. Creation only — a comment inherits its thread's tags by being on
 * it, and tagging each one would say nothing new.
 *
 * Best-effort by construction. A ticket that exists is worth more than a
 * ticket that is perfectly labelled, so a failure here is logged and the
 * creation still succeeds.
 */
export function applyPlatformTag(msg: { id: number; kind: string }, platform: string | null): void {
    if (msg.kind !== "ticket_created") return;
    const name = platformTagName(platform);
    // No header, or a platform we have no name for: nothing happens, and a
    // client that never sends it files tickets exactly as it always has.
    if (!name) return;
    try {
        // Created on first use. Safe only because `platformTagName` is a total
        // server-side map onto three names — see its module doc.
        const tag = getTagByName(name) ?? insertTag({ name, note: "Set automatically from the filing machine's platform." });
        addMessageTag(msg.id, tag.id, "aiball");
    } catch (e) {
        console.error(`[platform-tag] could not apply ${name} to #${msg.id}:`, e);
    }
}























