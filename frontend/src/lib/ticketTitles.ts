/**
 * #3258 — ticket titles, fetched once per ticket and kept for the page's life:
 * the tooltip of a `#NNN` link in a body, the header of the relation popover.
 * Asked when first needed (a hover), never for every link a body renders. A
 * ticket the board cannot name (gone, not visible, the bus down) is
 * remembered as unknown, not asked again on every hover.
 */
import { api } from "./api";

type Fetch = (id: number) => Promise<string | null>;

const fromBus: Fetch = async (id) => (await api.getTicketTitle(id))?.ticket?.title ?? null;

let fetchTitle: Fetch = fromBus;
const known = new Map<number, string | null>();
const asked = new Map<number, Promise<string | null>>();

/** The title if already known: a string, null for a ticket the board could not name, undefined when not asked yet. */
export function cachedTicketTitle(id: number): string | null | undefined {
    return known.get(id);
}

/** The title, asked once; concurrent callers share the one request. */
export function ticketTitle(id: number): Promise<string | null> {
    if (known.has(id)) return Promise.resolve(known.get(id) ?? null);
    let p = asked.get(id);
    if (!p) {
        p = fetchTitle(id)
            .catch(() => null)
            .then((title) => {
                known.set(id, title);
                asked.delete(id);
                return title;
            });
        asked.set(id, p);
    }
    return p;
}

/** A link's tooltip: `#3244 — Its title`. */
export function ticketTooltip(id: number, title: string): string {
    return `#${id} — ${title}`;
}

/** Tests only: fetch from `f` (the bus when omitted), with nothing known. */
export function resetTicketTitlesForTests(f?: Fetch): void {
    fetchTitle = f ?? fromBus;
    known.clear();
    asked.clear();
}
