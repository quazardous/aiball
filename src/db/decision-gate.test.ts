// #358 — gate de décision récence-aware. node:test + tsx (zero deps).
// Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDecisionGate, type DecisionGateEvent } from "./decision-gate.js";

// Humains du jeu de test : david. Tout le reste = agent.
const isHuman = (id: string) => id === "david";

// Petit builder : les events sont consommés dans l'ordre du tableau (= ordre
// d'id asc). On ne renseigne que ce qui compte pour chaque cas.
type Ev = Partial<DecisionGateEvent> & { kind: string };
function ev(e: Ev): DecisionGateEvent {
    return {
        ticketId: e.ticketId ?? 1,
        kind: e.kind,
        status: e.status ?? "approved",
        meta: e.meta ?? null,
        byAgent: e.byAgent ?? "claude-aiball-dev",
    };
}
function decision(kind: "plan" | "resolution" | "wontfix" | "escalation", status: string): string {
    return JSON.stringify({ decision: { kind, status } });
}
const gate = (events: DecisionGateEvent[]) => computeDecisionGate(events, isHuman);

test("plan pending → gaté", () => {
    const g = gate([ev({ kind: "comment_added", meta: decision("plan", "pending") })]);
    assert.equal(g.get(1), true);
});

test("#1113: plan pending + commentaire HUMAIN foreign postérieur → dé-gaté", () => {
    // Renverse le cas #600 : l'humain a repris la parole au lieu d'accepter/
    // rejeter → la proposition est moot, la balle revient à l'agent.
    const g = gate([
        ev({ kind: "comment_added", meta: decision("plan", "pending") }), // proposer=claude-aiball-dev
        ev({ kind: "comment_added", byAgent: "david" }), // plain human foreign
    ]);
    assert.equal(g.get(1), false);
});

test("#1113: plan pending + commentaire du PROPOSEUR (même agent) → reste gaté", () => {
    // #600 préservé pour le proposeur lui-même : parler tout seul ne ramène pas
    // la balle au backlog (toujours en attente de l'action de l'autre).
    const g = gate([
        ev({ kind: "comment_added", meta: decision("plan", "pending") }), // proposer=claude-aiball-dev
        ev({ kind: "comment_added", byAgent: "claude-aiball-dev" }), // même agent
    ]);
    assert.equal(g.get(1), true);
});

test("#1113: plan pending + commentaire d'un AGENT TIERS foreign → dé-gaté", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("plan", "pending") }), // proposer=claude-aiball-dev
        ev({ kind: "comment_added", byAgent: "autre-agent" }), // foreign agent
    ]);
    assert.equal(g.get(1), false);
});

test("#1113: proposeur summary_until (meta sans decision) après pending → reste gaté", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("resolution", "pending") }), // proposer=claude-aiball-dev
        ev({ kind: "comment_added", byAgent: "claude-aiball-dev", meta: JSON.stringify({ summary_until: "x" }) }),
    ]);
    assert.equal(g.get(1), true);
});

test("#1113: resolution pending + commentaire humain foreign postérieur → dé-gaté", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("resolution", "pending") }), // proposer=claude-aiball-dev
        ev({ kind: "comment_added", byAgent: "david" }),
    ]);
    assert.equal(g.get(1), false);
});

test("#1113: régression skybot #1109 — résolution pending puis échange plain (david Q / agent A / david Q) → dé-gaté", () => {
    const g = gate([
        ev({ kind: "comment_added", byAgent: "skybot-claude", meta: decision("resolution", "pending") }),
        ev({ kind: "comment_added", byAgent: "david" }),          // "quelle clé ?"
        ev({ kind: "comment_added", byAgent: "skybot-claude" }),  // réponse
        ev({ kind: "comment_added", byAgent: "david" }),          // nouvelle question
    ]);
    assert.equal(g.get(1), false);
});

test("#1113: commentaire foreign AVANT toute décision pending → pas de dé-gate parasite (reste gaté après pending)", () => {
    const g = gate([
        ev({ kind: "comment_added", byAgent: "david" }),          // pas de gate encore
        ev({ kind: "comment_added", byAgent: "skybot-claude", meta: decision("resolution", "pending") }),
    ]);
    assert.equal(g.get(1), true);
});

test("resolution ACCEPTED + commentaire humain postérieur → reste gaté (settled, pas de reopen implicite)", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("resolution", "accepted") }),
        ev({ kind: "comment_added", byAgent: "david" }),
    ]);
    assert.equal(g.get(1), true);
});

test("plan accepté = go-signal → dé-gaté", () => {
    const g = gate([ev({ kind: "comment_added", meta: decision("plan", "accepted") })]);
    assert.equal(g.get(1), false);
});

test("plan / resolution rejeté → dé-gaté", () => {
    assert.equal(gate([ev({ kind: "comment_added", meta: decision("plan", "rejected") })]).get(1), false);
    assert.equal(gate([ev({ kind: "comment_added", meta: decision("resolution", "rejected") })]).get(1), false);
});

test("#600 v7z5u6: legacy ticket_resolved (pending OU approved) + commentaire humain → reste gaté", () => {
    const pending = gate([
        ev({ kind: "ticket_resolved", status: "pending" }),
        ev({ kind: "comment_added", byAgent: "david" }),
    ]);
    assert.equal(pending.get(1), true);
    const approved = gate([
        ev({ kind: "ticket_resolved", status: "approved" }),
        ev({ kind: "comment_added", byAgent: "david" }),
    ]);
    assert.equal(approved.get(1), true);
});

test("#802: wontfix pending → gaté (symétrique resolution)", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("wontfix", "pending") }),
    ]);
    assert.equal(g.get(1), true);
});

test("#802: wontfix accepté → reste gaté (le ticket est fermé en parallèle, pas dans le gate)", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("wontfix", "accepted") }),
    ]);
    assert.equal(g.get(1), true);
});

test("#802: wontfix rejeté → dé-gaté (reporter dit non, le ticket reste ouvert)", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("wontfix", "pending") }),
        ev({ kind: "comment_added", meta: decision("wontfix", "rejected") }),
    ]);
    assert.equal(g.get(1), false);
});

test("#737: escalation pending → gaté (agent attend l'action humaine)", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("escalation", "pending") }),
    ]);
    assert.equal(g.get(1), true);
});

test("#737: escalation accepté = humain a fait l'action → dé-gaté (pas d'auto-close, l'agent peut continuer)", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("escalation", "pending") }),
        ev({ kind: "comment_added", meta: decision("escalation", "accepted") }),
    ]);
    assert.equal(g.get(1), false);
});

test("#737: escalation rejeté = pas une escalation → dé-gaté (agent peut re-classifier)", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("escalation", "pending") }),
        ev({ kind: "comment_added", meta: decision("escalation", "rejected") }),
    ]);
    assert.equal(g.get(1), false);
});

test("ticket_reopened (approved) dé-gate même après une résolution", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("resolution", "accepted") }),
        ev({ kind: "ticket_reopened", status: "approved" }),
    ]);
    assert.equal(g.get(1), false);
});

test("#600 v7z5u6: dernier-signal-gagne : pending → reject (dé-gate) → nouvelle proposition pending (re-gate)", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("plan", "pending") }),
        ev({ kind: "comment_added", meta: decision("plan", "rejected") }),
        ev({ kind: "comment_added", meta: decision("plan", "pending") }),
    ]);
    assert.equal(g.get(1), true);
});

test("commentaire humain sans gate préalable → pas d'entrée (non gaté)", () => {
    const g = gate([ev({ kind: "comment_added", byAgent: "david" })]);
    assert.equal(g.get(1), undefined);
});

test("décision pending non-approuvée (modération en attente) → ignorée", () => {
    const g = gate([ev({ kind: "comment_added", status: "pending", meta: decision("plan", "pending") })]);
    assert.equal(g.get(1), undefined);
});

test("#803: ticket_created avec plan pending → gaté", () => {
    const g = gate([
        ev({ kind: "ticket_created", meta: decision("plan", "pending") }),
    ]);
    assert.equal(g.get(1), true);
});

test("#803: ticket_created avec plan accepté → dé-gaté (go-signal)", () => {
    const g = gate([
        ev({ kind: "ticket_created", meta: decision("plan", "pending") }),
        ev({ kind: "comment_added", meta: decision("plan", "accepted") }),
    ]);
    assert.equal(g.get(1), false);
});

test("#803: ticket_created avec plan rejeté → dé-gaté (re-plan)", () => {
    const g = gate([
        ev({ kind: "ticket_created", meta: decision("plan", "pending") }),
        ev({ kind: "comment_added", meta: decision("plan", "rejected") }),
    ]);
    assert.equal(g.get(1), false);
});

test("tickets indépendants ne se mélangent pas", () => {
    const g = gate([
        ev({ ticketId: 1, kind: "comment_added", meta: decision("plan", "pending") }),
        ev({ ticketId: 2, kind: "comment_added", meta: decision("plan", "pending") }),
        ev({ ticketId: 2, kind: "comment_added", meta: decision("plan", "accepted") }), // dé-gate seulement #2
    ]);
    assert.equal(g.get(1), true);
    assert.equal(g.get(2), false);
});
