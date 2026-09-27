/**
 * #3068 — the HTTP routes that served bus methods, kept for the tests only.
 * The clients call the methods on the bus; production keeps a minimal HTTP API
 * (the web UI's files, uploads, login, probes, signals, pairing, and the GNOME
 * extension's project counters). Many tests still speak HTTP to reach a method:
 * `createTestApp()` mounts these routes for them, with the same parameter
 * mapping a route had (`serveMethod`), so what they test is the method.
 */
import { Router } from "express";
import { serveMethod } from "../bus/http.js";

export const legacyRoutes = Router();

// ---- from src/api.ts
legacyRoutes.post("/daemon/reload", serveMethod("daemon.reload"));
legacyRoutes.get("/strategy", serveMethod("strategy.get"));
legacyRoutes.get("/token-usage/timeseries", serveMethod("token_usage.timeseries"));
legacyRoutes.patch("/strategy", serveMethod("strategy.set"));
legacyRoutes.get("/projects/:project/strategy", serveMethod("project.strategy"));
legacyRoutes.patch("/projects/:project/strategy", serveMethod("project.set_strategy"));
legacyRoutes.get("/presence", serveMethod("consumer.presence"));
legacyRoutes.get("/projects/:project/standing-prompt", serveMethod("project.standing_prompt"));
legacyRoutes.get("/projects/:project/critical", serveMethod("project.critical"));
legacyRoutes.get("/projects/:project/milestones", serveMethod("project.milestones"));
legacyRoutes.patch("/projects/:project/standing-prompt", serveMethod("project.set_standing_prompt"));
legacyRoutes.post("/projects/:project/token-usage", serveMethod("project.add_token_usage"));
legacyRoutes.post("/projects", serveMethod("project.create", undefined, { status: 201 }));
legacyRoutes.get("/steps/timing", serveMethod("step.timing"));
legacyRoutes.get("/projects/:name/stats", serveMethod("project.stats"));
legacyRoutes.get("/projects/:name/stats-rich", serveMethod("project.stats_rich"));
legacyRoutes.get("/mention-suggestions", serveMethod("mention.suggestions"));
legacyRoutes.post("/projects/:name/purge", serveMethod("project.purge"));
legacyRoutes.get("/info", serveMethod("board.info"));
legacyRoutes.post("/tickets/purge", serveMethod("board.purge"));
legacyRoutes.post("/projects/:name/launch", serveMethod("project.launch"));
legacyRoutes.get("/launchers", serveMethod("launcher.list"));
legacyRoutes.post("/launchers/:id/run", serveMethod("launcher.run"));
legacyRoutes.get("/graph/neighbors", serveMethod("graph.neighbors"));
legacyRoutes.get("/graph/audit", serveMethod("graph.audit"));
legacyRoutes.get("/search", serveMethod("message.search"));

// ---- from src/api/agent-helpers.ts
legacyRoutes.get("/feed-path", serveMethod("project.feed_path"));

// ---- from src/api/agents.ts
legacyRoutes.post("/agents/:name/afk", serveMethod("consumer.afk", undefined, { status: 202 }));

// ---- from src/api/auth.ts
legacyRoutes.get("/me", serveMethod("consumer.me"));

// ---- from src/api/automation.ts
legacyRoutes.get("/automation/rules", serveMethod("automation.rules"));
legacyRoutes.post("/automation/rules", serveMethod("automation.create_rule", undefined, { status: 201 }));
legacyRoutes.delete("/automation/rules/:id", serveMethod("automation.delete_rule", undefined, { status: 204, respond: (res) => { res.end(); } }));
legacyRoutes.patch("/automation/rules/:id", serveMethod("automation.update_rule"));

// ---- from src/api/config.ts
legacyRoutes.get("/config", serveMethod("config.get"));

// ---- from src/api/consumers.ts
legacyRoutes.get("/consumers", serveMethod("consumer.list"));
legacyRoutes.get("/consumers/:consumer_id/wait-credit", serveMethod("consumer.wait_credit"));
legacyRoutes.get("/consumers/:consumer_id", serveMethod("consumer.get"));
legacyRoutes.post("/consumers/:consumer_id/loop-stop", serveMethod("consumer.stop_loop"));
legacyRoutes.post("/consumers/:consumer_id/prompt", serveMethod("consumer.prompt"));
legacyRoutes.post("/loops/message-all", serveMethod("loops.message_all"));
legacyRoutes.post("/loops/release-all", serveMethod("loops.release_all"));
legacyRoutes.post("/consumers", serveMethod("consumer.upsert"));
legacyRoutes.patch("/consumers/:consumer_id", serveMethod("consumer.update"));
legacyRoutes.delete("/consumers/:consumer_id", serveMethod("consumer.delete"));
legacyRoutes.put("/consumers/:consumer_id/state", serveMethod("consumer.push_state"));
legacyRoutes.get("/consumers/:consumer_id/backlog", serveMethod("consumer.backlog"));
legacyRoutes.put("/consumers/:consumer_id/bar", serveMethod("consumer.push_bar", (req) => ({ consumer_id: req.params.consumer_id, bar: req.body })));
legacyRoutes.get("/consumers/:consumer_id/bar", serveMethod("consumer.bar"));
legacyRoutes.post("/consumers/:consumer_id/bar-host", serveMethod("consumer.set_bar_host", undefined, { status: 202 }));
legacyRoutes.get("/nodes", serveMethod("node.list"));
legacyRoutes.get("/nodes/pairing", serveMethod("node.pairing"));
legacyRoutes.post("/nodes/pairing/:verb", serveMethod("node.set_pairing"));
legacyRoutes.get("/nodes/enrollments", serveMethod("node.enrollments"));
legacyRoutes.post("/nodes/enrollments/:id/:verdict", serveMethod("node.decide_enrollment"));
legacyRoutes.delete("/nodes/:node_id", serveMethod("node.revoke"));

// ---- from src/api/managed-config.ts
legacyRoutes.get("/managed-config", serveMethod("config.managed"));
legacyRoutes.put("/managed-config/:key", serveMethod("config.set"));
legacyRoutes.delete("/managed-config/:key", serveMethod("config.clear", undefined, { status: 204, respond: (res) => { res.end(); } }));

// ---- from src/api/messages.ts
legacyRoutes.post("/messages", serveMethod("message.post", (req) => req.body ?? {}, { status: 201 }));
legacyRoutes.get("/messages", serveMethod("message.list"));
legacyRoutes.get("/messages/:id", serveMethod("message.get"));
legacyRoutes.get("/decisions/mine", serveMethod("decision.mine"));
legacyRoutes.get("/decisions/plans-to-execute", serveMethod("decision.plans_to_execute"));
legacyRoutes.post("/messages/:id/approve", serveMethod("message.approve"));
legacyRoutes.post("/messages/:id/reject", serveMethod("message.reject"));
legacyRoutes.post("/messages/:id/accept-and-close", serveMethod("message.accept_and_close"));
legacyRoutes.post("/messages/:id/edit", serveMethod("message.edit"));
legacyRoutes.post("/messages/:id/delete", serveMethod("message.delete"));
legacyRoutes.post("/messages/:id/questions/:qid/answer", serveMethod("message.answer_question"));
legacyRoutes.post("/messages/:id/decide", serveMethod("message.decide"));
legacyRoutes.post("/messages/:id/resurface", serveMethod("message.resurface"));
legacyRoutes.post("/messages/:id/summarize", serveMethod("message.summarize"));
legacyRoutes.post("/messages/:id/vote", serveMethod("message.vote"));
legacyRoutes.post("/messages/:id/reclassify", serveMethod("message.reclassify"));
legacyRoutes.post("/messages/:id/promote", serveMethod("message.promote"));
legacyRoutes.post("/messages/:id/untag", serveMethod("message.untag"));
legacyRoutes.post("/messages/:id/step", serveMethod("message.step"));
legacyRoutes.post("/messages/:id/unstep", serveMethod("message.unstep"));
legacyRoutes.post("/messages/:id/note", serveMethod("message.note"));

// ---- from src/api/payloads.ts
legacyRoutes.get("/tickets/:id/payload", serveMethod("ticket.payload"));
legacyRoutes.put("/tickets/:id/payload", serveMethod("ticket.set_payload"));
legacyRoutes.post("/tickets/:id/payload/dump", serveMethod("ticket.dump_payload"));
legacyRoutes.delete("/tickets/:id/payload", serveMethod("ticket.revoke_payload"));

// ---- from src/api/pings.ts
legacyRoutes.get("/pings", serveMethod("ping.list"));
legacyRoutes.get("/pings/count", serveMethod("ping.count"));
legacyRoutes.post("/pings/mark-read", serveMethod("ping.mark_read"));

// ---- from src/api/read-tracking.ts
legacyRoutes.get("/unread", serveMethod("unread.list"));
legacyRoutes.get("/unread/count", serveMethod("unread.count"));
legacyRoutes.get("/my-pending/count", serveMethod("message.pending_count"));
legacyRoutes.get("/micro-status", serveMethod("consumer.micro_status"));
legacyRoutes.post("/mark-read", serveMethod("unread.mark_read"));
legacyRoutes.post("/backlog-wake", serveMethod("backlog.record_wake"));

// ---- from src/api/signal-keys.ts
legacyRoutes.get("/signal-keys", serveMethod("signal_key.list"));
legacyRoutes.post("/signal-keys", serveMethod("signal_key.create", undefined, { status: 201 }));
legacyRoutes.patch("/signal-keys/:key_id", serveMethod("signal_key.update"));
legacyRoutes.delete("/signal-keys/:key_id", serveMethod("signal_key.revoke"));
legacyRoutes.get("/projects/:name/signals", serveMethod("project.signals"));

// ---- from src/api/signals.ts
legacyRoutes.get("/signals", serveMethod("signal.list"));
legacyRoutes.post("/signals/:id/ack", serveMethod("signal.ack"));

// ---- from src/api/subscriptions.ts
legacyRoutes.post("/subscriptions", serveMethod("project.subscribe", undefined, { status: 201 }));
legacyRoutes.get("/subscriptions", serveMethod("project.subscriptions"));
legacyRoutes.delete("/subscriptions", serveMethod("project.unsubscribe", undefined, { status: 204, respond: (res) => { res.end(); } }));

// ---- from src/api/tags.ts
legacyRoutes.get("/tags", serveMethod("tag.list"));
legacyRoutes.post("/tags", serveMethod("tag.create", undefined, { status: 201 }));
legacyRoutes.put("/tags/override", serveMethod("tag.override"));
legacyRoutes.patch("/tags/:id", serveMethod("tag.update"));
legacyRoutes.delete("/tags/:id", serveMethod("tag.delete", undefined, { status: 204, respond: (res) => { res.end(); } }));
legacyRoutes.put("/messages/:id/tags", serveMethod("message.set_tags"));
legacyRoutes.post("/messages/:id/tags", serveMethod("message.add_tag", undefined, { status: 201 }));
legacyRoutes.delete("/messages/:id/tags/:tag", serveMethod("message.remove_tag"));

// ---- from src/api/ticket-subscriptions.ts
legacyRoutes.get("/ticket-subscriptions", serveMethod("ticket.subscriptions"));
legacyRoutes.post("/ticket-subscriptions", serveMethod("ticket.subscribe", undefined, { status: 201 }));
legacyRoutes.get("/ticket-subscriptions/:ticket_id", serveMethod("ticket.subscription"));
legacyRoutes.delete("/ticket-subscriptions/:ticket_id", serveMethod("ticket.unsubscribe"));

// ---- from src/api/tickets.ts
legacyRoutes.post("/tickets/:id/owner", serveMethod("ticket.set_owner"));
legacyRoutes.post("/tickets/:id/assign", serveMethod("ticket.assign"));
legacyRoutes.post("/tickets/:id/release", serveMethod("ticket.release"));
legacyRoutes.post("/tickets/:id/token-usage", serveMethod("ticket.add_token_usage"));
legacyRoutes.get("/tickets/:id/subscriptions", serveMethod("ticket.subscribers"));
legacyRoutes.get("/tickets/bookends", serveMethod("ticket.bookends"));
legacyRoutes.get("/inbox", serveMethod("inbox.list", undefined, {
    // #2071 — the total in a header, the body a plain array: what HTTP clients read.
    respond: (res, out) => {
        const { total, rows } = out as { total: number; rows: unknown[] };
        res.setHeader("X-Total-Count", String(total));
        res.json(rows);
    },
}));
legacyRoutes.get("/tickets", serveMethod("ticket.list"));
legacyRoutes.post("/tickets/:id/mark-read", serveMethod("ticket.mark_read"));
legacyRoutes.post("/tickets/:id/mark-unread", serveMethod("ticket.mark_unread"));
legacyRoutes.post("/tickets/:id/postpone", serveMethod("ticket.postpone"));
legacyRoutes.post("/tickets/:id/unsnooze", serveMethod("ticket.unsnooze"));
legacyRoutes.post("/tickets/:id/move", serveMethod("ticket.move"));
legacyRoutes.get("/tickets/:id/pending-children", serveMethod("ticket.pending_children"));
legacyRoutes.post("/tickets/:id/approve-pending-children", serveMethod("ticket.approve_pending_children"));
legacyRoutes.post("/tickets/import", serveMethod("ticket.import", undefined, { status: 201 }));
legacyRoutes.post("/tickets/:id/export", serveMethod("ticket.export", undefined, { status: 201 }));
legacyRoutes.post("/tickets/:id/step", serveMethod("ticket.step"));
legacyRoutes.post("/tickets/:id/unstep", serveMethod("ticket.unstep"));
legacyRoutes.post("/tickets/:id/milestone", serveMethod("ticket.set_milestone"));
legacyRoutes.post("/tickets/:id/relations", serveMethod("ticket.relate"));
legacyRoutes.get("/tickets/:id", serveMethod("ticket.get"));
