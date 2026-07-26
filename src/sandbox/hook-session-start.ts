/**
 * SessionStart hook for claude-sandbox sessions. Reads plate.json, fetches
 * each ticket from aiball, and prints a single JSON object on stdout that
 * Claude Code injects as additional context.
 *
 * Stdin (the hook payload from Claude Code) is intentionally drained but
 * ignored — none of its fields are relevant to bootstrap.
 *
 * Any error → emit empty JSON and exit 0. We never block the session due
 * to a bug in our own hook.
 */
import { AiballClient } from "../client.js";
import { readPlate } from "./state.js";

interface TicketResponse {
    ticket: {
        id: number;
        title: string | null;
        body: string | null;
    };
}

function emit(obj: unknown): never {
    process.stdout.write(JSON.stringify(obj) + "\n");
    process.exit(0);
}

async function main(): Promise<void> {
    const stateDir = process.env.SB_STATE_DIR;
    const sbName = process.env.SB_NAME ?? "(unnamed)";
    if (!stateDir) {
        // Invoked outside a sandbox; no-op.
        emit({});
    }

    let plate;
    try {
        plate = readPlate(stateDir!);
    } catch {
        emit({});
    }

    // Drain stdin so a long stdin pipe never blocks us. We don't read it.
    process.stdin.resume();
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => {});

    const client = new AiballClient();
    const briefs: string[] = [];
    for (const t of plate.tickets) {
        try {
            const resp = (await client.getTicket(t.id)) as TicketResponse;
            const title = resp.ticket.title ?? "";
            const body = resp.ticket.body ?? "";
            if (!title && !body) continue;
            briefs.push(`## #${t.id} — ${title}\n\n${body}`);
        } catch {
            briefs.push(`## #${t.id} — (unreachable: could not fetch from aiball)`);
        }
    }
    if (briefs.length === 0) emit({});

    const preamble = [
        `You are running in **sandbox \`${sbName}\`** as agent \`${client.agentId}\`.`,
        ``,
        `Your work plate is at \`${stateDir}/plate.json\`. Process each ticket below in order. Three actions are available:`,
        ``,
        `- **Close** a ticket when done: call MCP \`ticket_close({ticket_id: X})\`. The Stop hook will detect it and let you move to the next, or stop if all done.`,
        `- **Escalate** a blocked ticket: post a comment AND mark plate.json:`,
        `    1. MCP \`ticket_reply({target_id: X, body: "blocked on …, escalating"})\``,
        `    2. \`jq '.tickets |= map(if .id == X then .status = "escalated" else . end)' "${stateDir}/plate.json" > "${stateDir}/plate.json.tmp" && mv "${stateDir}/plate.json.tmp" "${stateDir}/plate.json"\``,
        `- **Halt** the loop if the context is saturated or something needs the human before any further work:`,
        `    \`jq '.halt = true' "${stateDir}/plate.json" > "${stateDir}/plate.json.tmp" && mv "${stateDir}/plate.json.tmp" "${stateDir}/plate.json"\``,
        ``,
        `The Stop hook releases when the plate is fully resolved OR \`.halt\` is true.`,
        ``,
        `# Tickets`,
        ``,
        briefs.join("\n\n"),
    ].join("\n");

    emit({
        hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: preamble,
        },
    });
}

main().catch(() => {
    process.stdout.write("{}\n");
    process.exit(0);
});
