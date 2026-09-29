/**
 * An agent's role and no-claim hint resolve like its id: the environment
 * (claude-loop exports AIBALL_ROLE / AIBALL_NO_CLAIM), else the folder's
 * `.aiball.yaml`. They used to come from the environment alone, so a plain
 * `claude` in a crew agent's folder — its MCP started from `.mcp.json`,
 * outside claude-loop — stated no role: the MCP subscribed it as an owner and
 * it could claim, whatever the yaml said.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiballClient, resolveConsumerStanding } from "./client.js";

const ROOT = mkdtempSync(join(tmpdir(), "aiball-standing-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

function folder(name: string, yaml: string | null): string {
    const d = mkdtempSync(join(ROOT, `${name}-`));
    if (yaml !== null) writeFileSync(join(d, ".aiball.yaml"), yaml);
    return d;
}

const CREW = "consumer:\n  agent: tvty-win\n  project: tvty\n  role: crew\n";
const NO_CLAIM_LEAD = "consumer:\n  agent: helper\n  project: tvty\n  no_claim: true\n";
const PLAIN = "consumer:\n  agent: tvty-claude\n  project: tvty\n";

test("with no environment, the folder's .aiball.yaml decides — crew never claims", () => {
    assert.deepEqual(resolveConsumerStanding({}, folder("crew", CREW)), { role: "crew", noClaim: true });
    assert.deepEqual(resolveConsumerStanding({}, folder("nc", NO_CLAIM_LEAD)), { role: null, noClaim: true });
    assert.deepEqual(resolveConsumerStanding({}, folder("plain", PLAIN)), { role: null, noClaim: false });
    assert.deepEqual(resolveConsumerStanding({}, folder("none", null)), { role: null, noClaim: false });
});

test("the environment wins over the yaml, as claude-loop sets it", () => {
    const crew = folder("crew-env", CREW);
    assert.deepEqual(resolveConsumerStanding({ AIBALL_ROLE: "lead", AIBALL_NO_CLAIM: "" }, crew), { role: "lead", noClaim: false });
    assert.deepEqual(resolveConsumerStanding({ AIBALL_ROLE: "crew", AIBALL_NO_CLAIM: "1" }, folder("p", PLAIN)), { role: "crew", noClaim: true });
    assert.equal(resolveConsumerStanding({ AIBALL_ROLE: "boss" }, crew).role, null, "an unknown role is not replaced by the yaml's");
});

test("a null cwd reads the environment alone", () => {
    assert.deepEqual(resolveConsumerStanding({}, null), { role: null, noClaim: false });
    assert.deepEqual(resolveConsumerStanding({ AIBALL_ROLE: "crew" }, null), { role: "crew", noClaim: true });
});

test("the client states the folder's standing, but not for another agent it was built for", () => {
    const saved = { cwd: process.env.AIBALL_CWD, role: process.env.AIBALL_ROLE, nc: process.env.AIBALL_NO_CLAIM, agent: process.env.AIBALL_AGENT };
    try {
        delete process.env.AIBALL_ROLE;
        delete process.env.AIBALL_NO_CLAIM;
        delete process.env.AIBALL_AGENT;
        process.env.AIBALL_CWD = folder("client", CREW);
        const own = new AiballClient({ url: "http://127.0.0.1:1" });
        assert.equal(own.agentId, "tvty-win");
        assert.equal(own.role, "crew");
        assert.equal(own.noClaim, true);
        const other = new AiballClient({ url: "http://127.0.0.1:1", agentId: "someone-else" });
        assert.equal(other.role, null);
        assert.equal(other.noClaim, false);
    } finally {
        for (const [k, v] of [["AIBALL_CWD", saved.cwd], ["AIBALL_ROLE", saved.role], ["AIBALL_NO_CLAIM", saved.nc], ["AIBALL_AGENT", saved.agent]] as const) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
});
