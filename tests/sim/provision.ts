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
 */
import { readFileSync } from "node:fs";
import { parseCohort } from "../../src/sim/cohort.js";
import { hashPassword } from "../../src/auth.js";
import { issueToken } from "../../src/db/tokens.js";
import { setPasswordHash, upsertConsumer } from "../../src/db.js";
import { createProject } from "../../src/db/projects.js";
import { upsertSubscription } from "../../src/db/subscriptions.js";
import { seedCounters } from "../lib.js";

const file = process.argv[2];
if (!file) {
    console.error("usage: provision.ts <cohort.yaml>");
    process.exit(2);
}
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

const agents: Record<string, { project: string; role: string; token: string }> = {};
for (const a of cohort.agents) {
    upsertConsumer({ consumer_id: a.id, kind: "agent", enabled: true });
    upsertSubscription(a.id, a.project, a.role);
    agents[a.id] = {
        project: a.project,
        role: a.role,
        token: issueToken({ consumer_id: a.id, kind: "agent", label: "sim agent" }).token,
    };
}

process.stdout.write(`SIM-COHORT:${JSON.stringify({
    moderator: { id: cohort.moderator.id, password: cohort.moderator.password, token: moderatorToken },
    projects: cohort.projects,
    agents,
})}\n`);
