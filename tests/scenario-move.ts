// #324 e2e — move cross-project (#294): the reporter moves a ticket to another
// project; the head's project changes. Driven through the business API.
// (#328 checklist: move cross-projet)
import { provision, post, move, ok, fail } from "./lib.js";

const src = "move-src";
const dst = "move-dst";

async function main(): Promise<void> {
    const tokA = provision("agent-a");

    const ticket = await post(tokA, { project: src, kind: "ticket_created", title: "move e2e", by_agent: "agent-a" });
    const ticketId = (ticket.ticket_id ?? ticket.id) as number;
    if (ticket.project !== src) fail(`ticket should start in "${src}", got "${ticket.project}"`);
    console.log(`ticket #${ticketId} in "${src}"`);

    // A (the reporter) moves it to the destination project.
    const moved = await move(tokA, ticketId, dst);
    console.log(`moved → project="${moved.project}"`);
    if (moved.project !== dst) fail(`ticket not moved to "${dst}": project="${moved.project}"`);

    ok(`move cross-project — ticket #${ticketId} "${src}" → "${dst}" (#294)`);
}

main().catch((e) => {
    console.error("scenario error:", e);
    process.exit(1);
});
