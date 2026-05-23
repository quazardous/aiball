// #324 e2e — moderation rules (#328 checklist q:5c791f). A rule matching
// `project` / `kind` / `by_agent` routes a NEW message to `auto` (auto-approved)
// vs `review` (pending); rules are first-match-wins by (position ASC, id ASC);
// and a registered HUMAN author bypasses moderation entirely. Engine under test:
// src/rules.ts `evaluate()` (human bypass → first matching enabled rule → else
// the project's strategy default).
//
// Unlike the in-process lifecycle bus of #364, moderation IS observable over
// HTTP from the shared daemon: the POST /api/messages response carries the
// resolved `status` ("approved" | "pending") and `matched_rule_id` (the rule
// that fired, or null for a bypass / strategy default). So this is a normal
// shared-daemon scenario. Distinct project "moderation" + every rule scoped with
// match_project → the rules can't leak onto the other scenarios' projects, and
// the assertions don't depend on the ambient default strategy.
import { provision, provisionHuman, post, createRule, ok, fail } from "./lib.js";

const project = "moderation";

async function main(): Promise<void> {
    const tokHuman = provisionHuman("human-mod"); // moderator: creates rules AND bypasses them
    const tokA = provision("agent-a"); // generic agent → reviewed
    const tokAuto = provision("agent-auto"); // agent allow-listed by a rule

    // Two project-scoped rules, evaluated first-match-wins by (position, id):
    //  - R_auto (pos 0): agent-auto's posts auto-approve — match on by_agent.
    //  - R_review (pos 10): every comment in this project goes to review — match
    //    on kind.
    // R_auto's lower position is the crux of the ordering test: agent-auto's
    // comment ALSO matches R_review, but R_auto is reached first → auto wins.
    const rAuto = await createRule(tokHuman, {
        match_project: project, match_by_agent: "agent-auto", decision: "auto", position: 0,
        note: "e2e: allow-list agent-auto",
    });
    const rReview = await createRule(tokHuman, {
        match_project: project, match_kind: "comment_added", decision: "review", position: 10,
        note: "e2e: review all comments",
    });
    const rAutoId = rAuto.id as number;
    if (typeof rAutoId !== "number" || typeof rReview.id !== "number") {
        fail(`rules not created: rAuto=${JSON.stringify(rAuto)} rReview=${JSON.stringify(rReview)}`);
    }

    // Parent ticket — created by the human (bypass → approved), so the comments
    // below attach to an approved thread without leaning on the ambient default
    // strategy for ticket_created. Doubles as the first human-bypass assertion.
    const ticket = await post(tokHuman, { project, kind: "ticket_created", title: "moderation e2e", by_agent: "human-mod" });
    if (ticket.status !== "approved") fail(`human-authored ticket should bypass moderation (approved), got status=${ticket.status}`);
    const ticketId = (ticket.ticket_id ?? ticket.id) as number;
    ok(`human bypass — ticket #${ticketId} by human-mod auto-approved (status=${ticket.status})`);

    // 1) review routing — agent-a's comment matches R_review (kind), not R_auto
    //    (by_agent ≠ agent-auto) → pending. The rule forces review even though
    //    the default `auto-reply` strategy would auto-approve a comment.
    const cReview = await post(tokA, {
        project, kind: "comment_added", ticket_id: ticketId, by_agent: "agent-a",
        body: "agent-a comment (should be reviewed)", summary_until: "agent-a posted; awaiting moderation",
    });
    if (cReview.status !== "pending") fail(`review rule should route agent-a's comment to pending, got status=${cReview.status}`);
    ok("review — agent-a's comment → pending (review rule overrode the permissive default)");

    // 2) auto routing + first-match-wins — agent-auto's comment matches BOTH
    //    rules, but R_auto (pos 0) is reached before R_review (pos 10) → approved,
    //    and matched_rule_id pins WHICH rule fired (proves it was the rule, not a
    //    strategy default).
    const cAuto = await post(tokAuto, {
        project, kind: "comment_added", ticket_id: ticketId, by_agent: "agent-auto",
        body: "agent-auto comment (allow-listed)", summary_until: "agent-auto posted; auto-approved",
    });
    if (cAuto.status !== "approved") fail(`auto rule should route agent-auto's comment to approved, got status=${cAuto.status}`);
    if (cAuto.matched_rule_id !== rAutoId) fail(`agent-auto's comment should match rule #${rAutoId} (first-match-wins over the review rule), got matched_rule_id=${cAuto.matched_rule_id}`);
    ok(`auto — agent-auto's comment → approved via rule #${rAutoId} (won over the review rule on position)`);

    // 3) human bypass over an applicable review rule — human-mod's comment WOULD
    //    match R_review, but isHuman() short-circuits evaluate() before any rule
    //    is consulted → approved with matched_rule_id=null (the null is what
    //    distinguishes a bypass from a rule-driven auto, which carries the id).
    const cHuman = await post(tokHuman, {
        project, kind: "comment_added", ticket_id: ticketId, by_agent: "human-mod",
        body: "human-mod comment (bypasses the review rule)", summary_until: "human-mod posted; bypassed moderation",
    });
    if (cHuman.status !== "approved") fail(`human author should bypass the review rule (approved), got status=${cHuman.status}`);
    if (cHuman.matched_rule_id !== null) fail(`human bypass should set matched_rule_id=null (not a rule decision), got matched_rule_id=${cHuman.matched_rule_id}`);
    ok("human bypass — human-mod's comment → approved with matched_rule_id=null (bypass beat the applicable review rule)");

    ok("moderation rules — auto vs review by project/kind/by_agent (first-match-wins) + human bypass (#328 q:5c791f)");
    process.exit(0);
}

main().catch((e) => {
    console.error("scenario error:", e);
    process.exit(1);
});
