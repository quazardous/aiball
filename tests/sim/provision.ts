/**
 * Provision the simulated board's cohort. Runs INSIDE the sim daemon container
 * (`npm run sim -- up` calls it through `docker compose exec`), because
 * creating consumers and minting tokens is the one thing that goes to the
 * database instead of the API — the same carve-out as tests/lib.ts.
 *
 * Prints one line, `SIM-COHORT:<json>`, carrying every token; anything else on
 * stdout (boot logs) is ignored by the CLI.
 *
 *     npx tsx tests/sim/provision.ts tests/sim/cohort.yaml
 *     npx tsx tests/sim/provision.ts --from-live --as <agent>[,<agent>] [--moderator <human>]
 *
 * `--from-live` provisions nothing new: the board is a sanitized copy of the
 * live one (no token left, no password), so it only mints a token for each
 * agent named, as it stands on the copy (its project and role), and sets the
 * moderator's password again.
 */
import { readFileSync } from "node:fs";
import { parseCohort } from "../../src/sim/cohort.js";
import { hashPassword } from "../../src/auth.js";
import { issueToken } from "../../src/db/tokens.js";
import { getConsumer, setPasswordHash, updateConsumer, upsertConsumer } from "../../src/db.js";
import { createProject } from "../../src/db/projects.js";
import { listSubscriptions, upsertSubscription } from "../../src/db/subscriptions.js";
import { seedCounters } from "../lib.js";

const MODERATOR_PASSWORD = "simulator";
const args = process.argv.slice(2);

function option(name: string): string | undefined {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
}

type Cohort = {
    moderator: { id: string; password: string; token: string };
    projects: string[];
    agents: Record<string, { project: string; role: string; token: string }>;
};

async function fromCohortFile(file: string): Promise<Cohort> {
    const cohort = parseCohort(readFileSync(file, "utf8"));

    // A fresh database numbers comments from 1, like tickets, and a comment id that
    // equals a ticket id misresolves when a gesture addresses it (approve, decide).
    seedCounters();

    for (const name of cohort.projects) {
        try {
            createProject({ name, created_by: cohort.moderator.id });
        } catch {
            // already there: provisioning twice keeps the board as it is
        }
    }

    upsertConsumer({ consumer_id: cohort.moderator.id, kind: "human", enabled: true });
    setPasswordHash(cohort.moderator.id, await hashPassword(cohort.moderator.password));
    const moderatorToken = issueToken({ consumer_id: cohort.moderator.id, kind: "auth", label: "sim moderator" }).token;

    const agents: Cohort["agents"] = {};
    for (const a of cohort.agents) {
        upsertConsumer({ consumer_id: a.id, kind: "agent", enabled: true });
        if (!a.canClaim) updateConsumer(a.id, { can_claim: false });
        upsertSubscription(a.id, a.project, a.role);
        agents[a.id] = {
            project: a.project,
            role: a.role,
            token: issueToken({ consumer_id: a.id, kind: "agent", label: "sim agent" }).token,
        };
    }
    return {
        moderator: { id: cohort.moderator.id, password: cohort.moderator.password, token: moderatorToken },
        projects: cohort.projects,
        agents,
    };
}

async function fromLiveCopy(names: string[], moderatorId: string): Promise<Cohort> {
    const moderator = getConsumer(moderatorId);
    if (!moderator || moderator.kind !== "human") throw new Error(`no human "${moderatorId}" on the live copy (--moderator)`);
    setPasswordHash(moderatorId, await hashPassword(MODERATOR_PASSWORD));
    const moderatorToken = issueToken({ consumer_id: moderatorId, kind: "auth", label: "sim moderator" }).token;

    const agents: Cohort["agents"] = {};
    for (const id of names) {
        const consumer = getConsumer(id);
        if (!consumer || consumer.kind !== "agent") throw new Error(`no agent "${id}" on the live copy`);
        // The seat an agent's loop runs in: the project it owns, else the first it follows.
        const subs = listSubscriptions(id);
        const seat = subs.find((s) => s.role === "owner") ?? subs[0];
        if (!seat) throw new Error(`agent "${id}" subscribes to no project on the live copy`);
        agents[id] = {
            project: seat.project,
            role: seat.role,
            token: issueToken({ consumer_id: id, kind: "agent", label: "sim agent" }).token,
        };
    }
    return {
        moderator: { id: moderatorId, password: MODERATOR_PASSWORD, token: moderatorToken },
        projects: [...new Set(Object.values(agents).map((a) => a.project))],
        agents,
    };
}

let cohort: Cohort;
if (args.includes("--from-live")) {
    const names = (option("--as") ?? "").split(",").map((n) => n.trim()).filter(Boolean);
    if (names.length === 0) {
        console.error("usage: provision.ts --from-live --as <agent>[,<agent>] [--moderator <human>]");
        process.exit(2);
    }
    cohort = await fromLiveCopy(names, option("--moderator") ?? "david");
} else {
    if (!args[0]) {
        console.error("usage: provision.ts <cohort.yaml> | --from-live --as <agent>[,<agent>]");
        process.exit(2);
    }
    cohort = await fromCohortFile(args[0]);
}

process.stdout.write(`SIM-COHORT:${JSON.stringify(cohort)}\n`);
