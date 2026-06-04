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
function decision(kind: "plan" | "resolution", status: string): string {
    return JSON.stringify({ decision: { kind, status } });
}
const gate = (events: DecisionGateEvent[]) => computeDecisionGate(events, isHuman);

test("plan pending → gaté", () => {
    const g = gate([ev({ kind: "comment_added", meta: decision("plan", "pending") })]);
    assert.equal(g.get(1), true);
});

test("#600 v7z5u6: plan pending + commentaire HUMAIN postérieur → reste gaté", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("plan", "pending") }),
        ev({ kind: "comment_added", byAgent: "david" }), // plain human
    ]);
    assert.equal(g.get(1), true);
});

test("#600 v7z5u6: plan pending + commentaire AGENT postérieur → reste gaté", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("plan", "pending") }),
        ev({ kind: "comment_added", byAgent: "claude-aiball-dev" }), // agent plain
    ]);
    assert.equal(g.get(1), true);
});

test("#600 v7z5u6: agent summary_until (meta sans decision) après pending → reste gaté", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("resolution", "pending") }),
        ev({ kind: "comment_added", byAgent: "claude-aiball-dev", meta: JSON.stringify({ summary_until: "x" }) }),
    ]);
    assert.equal(g.get(1), true);
});

test("#600 v7z5u6: resolution pending + commentaire humain postérieur → reste gaté", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("resolution", "pending") }),
        ev({ kind: "comment_added", byAgent: "david" }),
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

test("tickets indépendants ne se mélangent pas", () => {
    const g = gate([
        ev({ ticketId: 1, kind: "comment_added", meta: decision("plan", "pending") }),
        ev({ ticketId: 2, kind: "comment_added", meta: decision("plan", "pending") }),
        ev({ ticketId: 2, kind: "comment_added", meta: decision("plan", "accepted") }), // dé-gate seulement #2
    ]);
    assert.equal(g.get(1), true);
    assert.equal(g.get(2), false);
});
