/**
 * #3068 — the moderator's credentials panels on the bus: proxy nodes (#424),
 * their pairing window and requests (#2074), and signal keys with what a
 * project received (#2276). All a human's. A node or a key is addressed by
 * its non-secret id; a key's token leaves the daemon once, in the answer that
 * mints it. The pairing requests themselves stay on HTTP: a node asking to be
 * enrolled holds no credential yet.
 */
import { z } from "zod";
import { consumerIdOf, defineMethod, Refusal } from "../methods.js";
import { listNodesWithRevoked, revokeNode } from "../../db/nodes.js";
import { approveEnrollment, listEnrollments, rejectEnrollment } from "../../db/node-enrollments.js";
import { getProxyNodeWsState } from "../../proxy-ws.js";
import { DEFAULT_PAIRING_WINDOW_MS, closePairingWindow, openPairingWindow, pairingWindow } from "../../node-pairing-window.js";
import { issueSignalKey, listProjectSignals, listSignalKeys, revokeSignalKey, updateSignalKey } from "../../db/signal-keys.js";
import { broadcast } from "../../ws.js";
import { ERROR_CODES } from "../../domain.js";

const humanOnly = (message: string) => ({
    who: ["human"] as const,
    denied: { message, code: ERROR_CODES.MODERATOR_ONLY },
});

/**
 * The proxy nodes, with their label, last activity and peer address, the
 * consumers each relays, and (#510) the state of its reverse channel; (#2085)
 * the ones revoked lately stay listed, as a receipt.
 */
defineMethod({
    name: "node.list",
    ...humanOnly("nodes list is moderator-only"),
    params: z.object({}),
    run: () => listNodesWithRevoked().map((n) => ({ ...n, ws_state: n.revoked_at ? null : getProxyNodeWsState(n.node_id) })),
});

/** #2074 — the pairing window: while it is shut, no node may ask to be enrolled. */
defineMethod({
    name: "node.pairing",
    ...humanOnly("pairing window is moderator-only"),
    params: z.object({}),
    run: () => pairingWindow(),
});

/** Open the pairing window for `minutes` (the default when absent), or close it. */
defineMethod({
    name: "node.set_pairing",
    ...humanOnly("pairing window is moderator-only"),
    params: z.object({ verb: z.string(), minutes: z.unknown().optional() }),
    run: (caller, p) => {
        if (p.verb !== "open" && p.verb !== "close") throw new Refusal(400, "verb must be open or close");
        let w: ReturnType<typeof pairingWindow>;
        if (p.verb === "close") {
            w = closePairingWindow();
        } else {
            const m = p.minutes;
            const ms = typeof m === "number" && Number.isFinite(m) && m > 0 ? m * 60_000 : DEFAULT_PAIRING_WINDOW_MS;
            w = openPairingWindow(consumerIdOf(caller), ms);
        }
        broadcast({ type: "consumer_changed", data: { pairing_window: w } });
        return w;
    },
});

/** #2074 — the pairing requests, each with the code the node printed. */
defineMethod({
    name: "node.enrollments",
    ...humanOnly("pairing requests are moderator-only"),
    params: z.object({}),
    run: () => listEnrollments(),
});

/** Approve or reject a pairing request; one no longer pending (expired, decided) is a 409. */
defineMethod({
    name: "node.decide_enrollment",
    ...humanOnly("approving a node is moderator-only"),
    params: z.object({ id: z.string(), verdict: z.string() }),
    run: (caller, p) => {
        if (p.verdict !== "approve" && p.verdict !== "reject") throw new Refusal(400, "verdict must be approve or reject");
        const me = consumerIdOf(caller);
        const view = p.verdict === "approve" ? approveEnrollment(p.id, me) : rejectEnrollment(p.id, me);
        if (!view) throw new Refusal(409, "pairing request is no longer pending");
        broadcast({ type: "consumer_changed", data: { enrollment: view } });
        return view;
    },
});

/** #424 — revoke a node: its token goes, and it can no longer relay. */
defineMethod({
    name: "node.revoke",
    ...humanOnly("node revoke is moderator-only"),
    params: z.object({ node_id: z.string() }),
    run: (caller, p) => {
        if (!revokeNode(p.node_id, consumerIdOf(caller))) throw new Refusal(404, "node not found");
        broadcast({ type: "consumer_changed", data: { node_id: p.node_id, revoked: true } });
        return { node_id: p.node_id, revoked: true };
    },
});

const SIGNALS_ONLY = "signal keys and received signals are moderator-only";

/** #2276 — the signal keys, or those granted a project. */
defineMethod({
    name: "signal_key.list",
    ...humanOnly(SIGNALS_ONLY),
    params: z.object({ project: z.string().optional() }),
    run: (_caller, p) => listSignalKeys(p.project || undefined),
});

/** Mint a signal key; its token is in this answer and nowhere else, ever. */
defineMethod({
    name: "signal_key.create",
    ...humanOnly(SIGNALS_ONLY),
    params: z.object({ label: z.unknown().optional(), note: z.unknown().optional(), scopes: z.unknown().optional(), projects: z.unknown().optional() }),
    run: (_caller, p) => {
        const r = issueSignalKey(p.label, p.note, p.scopes, p.projects);
        if ("error" in r) throw new Refusal(r.status, r.error);
        return r;
    },
});

/** Change a key's note, scopes or projects. */
defineMethod({
    name: "signal_key.update",
    ...humanOnly(SIGNALS_ONLY),
    params: z.object({ key_id: z.string(), note: z.unknown().optional(), scopes: z.unknown().optional(), projects: z.unknown().optional() }),
    run: (_caller, p) => {
        const r = updateSignalKey(p.key_id, { note: p.note, scopes: p.scopes, projects: p.projects });
        if ("error" in r) throw new Refusal(r.status, r.error);
        return r;
    },
});

/** Revoke a signal key. */
defineMethod({
    name: "signal_key.revoke",
    ...humanOnly(SIGNALS_ONLY),
    params: z.object({ key_id: z.string() }),
    run: (_caller, p) => {
        if (!revokeSignalKey(p.key_id)) throw new Refusal(404, "no signal key with this id");
        return { key_id: p.key_id, revoked: true };
    },
});

/** The signals a project received. */
defineMethod({
    name: "project.signals",
    ...humanOnly(SIGNALS_ONLY),
    params: z.object({ name: z.string() }),
    run: (_caller, p) => ({ project: p.name, signals: listProjectSignals(p.name) }),
});
