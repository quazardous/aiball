/**
 * Stop hook for claude-sandbox sessions. Decides whether to let Claude
 * stop (emit `{}`) or continue (emit `{decision:"block", reason}`).
 *
 * Release conditions (any one releases):
 *  1. plate.json missing/unreadable.
 *  2. plate.json has .halt === true.
 *  3. No actionable ticket remains.
 *  4. Anti-oscillation: same plate fingerprint + same blocked ticket as
 *     the prior call → no progress, release to avoid a tight loop.
 *
 * Otherwise block with the next actionable ticket as reason.
 *
 * Any error → emit empty JSON and exit 0. We never block due to a bug.
 */
import { AiballClient } from "../client.js";
import {
    readPlate,
    plateFingerprint,
    readLastBlock,
    writeLastBlock,
} from "./state.js";

interface TicketResponse {
    ticket: {
        id: number;
        title: string | null;
        body: string | null;
        closed: boolean;
        status: "pending" | "approved" | "rejected";
    };
}

function emit(obj: unknown): never {
    process.stdout.write(JSON.stringify(obj) + "\n");
    process.exit(0);
}

async function main(): Promise<void> {
    const stateDir = process.env.SB_STATE_DIR;
    if (!stateDir) emit({});

    let plate;
    try {
        plate = readPlate(stateDir!);
    } catch {
        emit({});
    }

    // Drain stdin (the Claude Code hook payload). Currently unused.
    process.stdin.resume();
    process.stdin.on("data", () => {});

    // 1. halt → release.
    if (plate.halt === true) {
        writeLastBlock(stateDir!, null);
        emit({});
    }

    const fp = plateFingerprint(plate);
    const client = new AiballClient();

    let actionable: { id: number; title: string; body: string } | null = null;
    for (const t of plate.tickets) {
        if (t.status === "closed" || t.status === "escalated" || t.status === "rejected") {
            continue;
        }
        let resp: TicketResponse | null = null;
        try {
            resp = (await client.getTicket(t.id)) as TicketResponse;
        } catch {
            // Daemon unreachable: treat as actionable so the user sees a
            // visible "unreachable" message rather than a silent release.
            actionable = {
                id: t.id,
                title: "(unreachable: could not fetch from aiball)",
                body: "",
            };
            break;
        }
        if (resp.ticket.closed === true || resp.ticket.status === "rejected") {
            continue;
        }
        actionable = {
            id: t.id,
            title: resp.ticket.title ?? "",
            body: resp.ticket.body ?? "",
        };
        break;
    }

    if (!actionable) {
        writeLastBlock(stateDir!, null);
        emit({});
    }

    // Anti-oscillation: same plate + same ticket as last block → release.
    const last = readLastBlock(stateDir!);
    if (last && last.plate_fp === fp && last.blocked_ticket_id === actionable.id) {
        writeLastBlock(stateDir!, null);
        emit({});
    }

    writeLastBlock(stateDir!, {
        plate_fp: fp,
        blocked_ticket_id: actionable.id,
    });

    const reasonParts = [`Continue with #${actionable.id} — ${actionable.title}.`];
    if (actionable.body) reasonParts.push("", actionable.body);
    emit({
        decision: "block",
        reason: reasonParts.join("\n"),
    });
}

main().catch(() => {
    process.stdout.write("{}\n");
    process.exit(0);
});
