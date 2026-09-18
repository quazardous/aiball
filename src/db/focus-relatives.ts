/**
 * #2757 — a ticket's relatives one step away, for expanding a wake focus
 * (`123+`, `++123`, `123~`). Read from the typed relations, from the ticket's
 * own side: `parent_of` points at its children, `child_of` at its parents, and
 * every active relation counts as a link.
 */
import type { FocusRelatives } from "../wake-focus.js";
import { listTypedRelationsForTicket } from "./messages.js";

export function focusRelatives(id: number): FocusRelatives {
    const out: FocusRelatives = { children: [], parents: [], linked: [] };
    for (const r of listTypedRelationsForTicket(id)) {
        if (r.kind === "parent_of") out.children.push(r.target_ticket_id);
        else if (r.kind === "child_of") out.parents.push(r.target_ticket_id);
        out.linked.push(r.target_ticket_id);
    }
    return out;
}
