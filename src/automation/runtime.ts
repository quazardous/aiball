/**
 * #457 slice 2 — automation runtime : subscribe to lifecycle events, ask the
 * pure matcher (`./engine.ts`) for the first matching rule, and dispatch the
 * action.
 *
 * What's wired in slice 2 :
 *   - `ticket_created` trigger : fires on `op="created"` (auto-approved path)
 *     and `op="decided"` (manual approval path) for `kind="ticket_created"` +
 *     `status="approved"`. The handler self-filters so a pending ticket
 *     doesn't pre-fire (and a rejected one never fires).
 *   - `ticket_tagged` trigger : fires from the tag mutation API handlers
 *     (POST/PUT `/messages/:id/tags`) once per ADDED tag. Tag REMOVALS don't
 *     fire — the engine's `match_tag_added` lever and the trigger name read
 *     as "tag-added".
 *   - `assign` action : `setTicketAssignment` + `upsertTicketSubscription` +
 *     a `message_edited` broadcast — same side-effect set as a
 *     `POST /tickets/:id/assign` from a human moderator, but stamped
 *     `assigned_by: "automation"` for audit.
 *
 * Out of scope :
 *   - `decision` / `pickup` action wiring : those legacy paths stay on their
 *     existing rules.ts / work-filters.ts engines until slice 3 migrates
 *     them onto the unified engine.
 *   - `add_tag` / `set_priority` / `notify` actions : kind values exist in the
 *     schema (`db/automation.ts`) but no caller emits them yet.
 *
 * Idempotent : `registerAutomationRuntime()` returns its prior teardown if
 * called twice. `daemon.ts main()` calls it once at boot ; tests opt in
 * explicitly so test suites that don't exercise automation don't pay the
 * subscriber cost.
 */
import { onLifecycle, type LifecycleEvent } from "../event-bus.js";
import type { AutomationAction } from "../db/automation.js";
import { resolvedEnabledRulesForTrigger } from "./resolved-rules.js";
import { firstMatchingRule, type AutomationEvent } from "./engine.js";
import { setTicketAssignment } from "../db/tickets.js";
import { upsertTicketSubscription } from "../db/subscriptions.js";
import { editMessage, getMessage } from "../db/messages.js";
import { broadcast } from "../ws.js";
import type { Message } from "../db.js";

let unregister: (() => void) | null = null;

/**
 * Register the lifecycle subscriber. Idempotent : returns the prior teardown
 * when called twice (no double-attach), so `daemon.ts` calls it unconditionally
 * at boot and tests can also call it without colliding.
 */
export function registerAutomationRuntime(): () => void {
    if (unregister) return unregister;
    const off = onLifecycle(handleLifecycle);
    unregister = () => {
        off();
        unregister = null;
    };
    return unregister;
}

function handleLifecycle(event: LifecycleEvent): void {
    try {
        // Only fire automation on APPROVED rows : a pending submission must
        // not drive side-effects (could be rejected next), and a rejected one
        // never fires (the moderation path emits op="decided" with
        // status="rejected", which we filter out here).
        if (event.message.status !== "approved") return;
        if (event.message.kind !== "ticket_created") return;

        const m = event.message;
        if (event.op === "created" || event.op === "decided") {
            // Both ends of the moderation flow land here :
            //   - op="created" + status="approved" → auto-approved path
            //     (submitMessage emits "created" with the already-approved
            //     row, no later "decided").
            //   - op="decided" + status="approved" → human moderator
            //     accepted a previously-pending ticket.
            // For an auto-approved row, only "created" fires (no "decided"
            // follows). For a moderated row, "created" was filtered out
            // by the status check above, and "decided" fires once on
            // approval. No double-fire.
            fireAutomation(
                {
                    trigger: "ticket_created",
                    project: m.project,
                    by_agent: m.by_agent,
                    intent: m.intent ?? null,
                    priority: m.priority ?? null,
                    // Tags at this point : empty by construction. MCP/API
                    // creates the ticket first, sets tags after. A rule with
                    // `has_tags:[win]` matched by `ticket_tagged` instead is
                    // the right shape for david's scenarios — and a YAML
                    // `triggers: [ticket_created, ticket_tagged]` covers both
                    // entry points without surprises here.
                    ticket_tags: [],
                },
                m,
            );
        } else if (event.op === "tagged") {
            const added = event.added_tag ?? "";
            if (!added) return;
            fireAutomation(
                {
                    trigger: "ticket_tagged",
                    project: m.project,
                    tag_added: added,
                    ticket_tags: event.all_tags ?? [],
                    intent: m.intent ?? null,
                    priority: m.priority ?? null,
                },
                m,
            );
        }
    } catch (e) {
        // Never crash the lifecycle bus on an automation error — log + drop.
        console.error("[automation] lifecycle handler error :", e);
    }
}

function fireAutomation(event: AutomationEvent, ticket: Message): void {
    try {
        // CRUD already orders DB rules by (position asc, id asc) — engine
        // doesn't re-sort. YAML rules (slice 3) are appended after the DB
        // rules in declaration order, so an operator-set DB rule wins over
        // any matching YAML default.
        const rules = resolvedEnabledRulesForTrigger(event.trigger);
        const match = firstMatchingRule(rules, event);
        if (!match) return;
        // #457 slice 5.4 — run the FULL stack of actions on a match, not
        // just the first one. david `aa48pd` : "on doit pouvoir stack
        // plusieurs actions". Fail-isolated (david `2r3w6a` ack : we
        // postpone fail-fast for later) — one action error doesn't abort
        // the rest. Always at least one entry in `match.actions` (the
        // insert path rejects empty ; legacy rows synth from `action`).
        executeActions(match.actions, ticket);
    } catch (e) {
        console.error("[automation] fire error for trigger", event.trigger, ":", e);
    }
}

function executeActions(actions: AutomationAction[], ticket: Message): void {
    for (const action of actions) {
        try {
            executeAction(action, ticket);
        } catch (e) {
            // Fail-isolated : the next action still runs. The error is
            // logged with the action kind so the operator can spot which
            // one in the stack went wrong.
            console.error(
                "[automation] action",
                action.kind,
                "failed on ticket",
                ticket.id,
                ":",
                e,
            );
        }
    }
}

function executeAction(action: AutomationAction, ticket: Message): void {
    switch (action.kind) {
        case "assign": {
            if (!action.consumer_id) return;
            // Mirror the side-effect set of POST /tickets/:id/assign
            // (#436) when a moderator pushes responsibility :
            //   1. persistent assignee (assigned_by="automation" for audit).
            //   2. subscribe the assignee so they get pings on the ticket.
            //   3. broadcast message_edited so open UIs refresh live.
            setTicketAssignment(ticket.id, action.consumer_id, "automation");
            upsertTicketSubscription(action.consumer_id, ticket.id);
            const updated = getMessage(ticket.id);
            if (updated) broadcast({ type: "message_edited", data: updated });
            return;
        }
        case "set_priority": {
            // #457 slice 5.4 — bump/lower a ticket's priority on rule fire.
            // Uses the same editMessage path the UI / API call when the
            // operator edits a ticket directly (priority CHECK + tickets-only
            // gating already enforced in db/messages.ts). Broadcast so open
            // inboxes refresh the urgency chip live.
            editMessage(ticket.id, { priority: action.priority });
            const updated = getMessage(ticket.id);
            if (updated) broadcast({ type: "message_edited", data: updated });
            return;
        }
        case "decision":
        case "pickup":
            // `decision` (moderation, pre-write verdict) et `pickup`
            // (work-filter, read-time gate) ne tombent JAMAIS dans le
            // dispatch lifecycle async — ils sont évalués synchronement
            // via `rules.ts::evaluate()` et
            // `automation/work-filter-gate.ts::ticketPassesAutomationWorkFilter()`
            // qui interrogent le moteur unifié directement (#483).
            return;
        case "add_tag":
        case "notify":
            // Deferred — aucun caller lifecycle n'émet ces actions
            // aujourd'hui (les kinds existent dans le schéma mais
            // attendent un slice futur pour être branchés).
            return;
    }
}
