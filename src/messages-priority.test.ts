/**
 * #1156 (REX runic #1155) — `priority` sur `ticket_new` était acceptée par le
 * schéma MCP mais inconnue de `validateNewMessage` → droppée SILENCIEUSEMENT,
 * le défaut SQL s'appliquait. Le fix miroir le handling `intent` : validée si
 * présente (400 sur valeur inconnue, pas de drop silencieux), forwardée sur
 * ticket_created, nullée ailleurs.
 *
 * Setup : throwaway DB via AIBALL_HOME avant les imports (même pattern que
 * messages-decision-guard.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1156-"));

const { getDb } = await import("./db/connection.js");
const { submitMessage, validateNewMessage } = await import("./messages.js");
const { createProject } = await import("./db/projects.js");

getDb();
createProject({ name: "prio-test" });

test("#1156: priority forwardée par le validateur sur ticket_created", () => {
    const v = validateNewMessage({
        project: "prio-test",
        kind: "ticket_created",
        title: "low ticket",
        priority: "low",
        by_agent: "agent-x",
    });
    assert.ok(!("error" in v), JSON.stringify(v));
    assert.equal(v.priority, "low");
});

test("#1156: priority invalide → erreur explicite (pas de drop silencieux)", () => {
    const v = validateNewMessage({
        project: "prio-test",
        kind: "ticket_created",
        title: "bad prio",
        priority: "asap",
    });
    assert.ok("error" in v);
    assert.match(v.error, /priority must be one of/);
});

test("#1156: priority absente → null (le défaut SQL s'applique en aval)", () => {
    const v = validateNewMessage({
        project: "prio-test",
        kind: "ticket_created",
        title: "no prio",
    });
    assert.ok(!("error" in v));
    assert.equal(v.priority, null);
});

test("#1156: priority sur comment_added → nullée (tickets only, miroir d'intent)", () => {
    const v = validateNewMessage({
        project: "prio-test",
        kind: "comment_added",
        ticket_id: 1,
        body: "x",
        priority: "high",
        by_agent: "human",
        summary_until: "s",
    });
    assert.ok(!("error" in v), JSON.stringify(v));
    assert.equal(v.priority, null);
});

test("#1156: end-to-end — le ticket créé PORTE la priorité (le bug runic : 'low' devenait 'normal')", () => {
    const v = validateNewMessage({
        project: "prio-test",
        kind: "ticket_created",
        title: "e2e low",
        priority: "low",
        by_agent: "agent-x",
    });
    assert.ok(!("error" in v));
    const msg = submitMessage(v);
    const row = getDb().$client
        .prepare("SELECT priority FROM tickets WHERE id = ?")
        .get(msg.id) as { priority: string } | undefined;
    assert.equal(row?.priority, "low");
});
