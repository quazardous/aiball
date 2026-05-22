#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop PreToolUse hook for `AskUserQuestion` (#264).
 *
 * David's "best of 2 mondes" (#nt5w7b): don't amputate Claude's
 * AskUserQuestion feature, but in an AUTONOMOUS loop (no human in front)
 * a multi-choice dialog stalls the loop — there's nobody to click. So we
 * deny AskUserQuestion ONLY when we're inside a loop AND no human is
 * taking over, and the deny reason redirects the agent to ask via an
 * aiball ticket comment instead (the "réponse passe-partout + prompt"
 * david asked for).
 *
 * Fail-open by design (matters: getting it backwards would block the
 * dialog in every interactive session):
 *   - not a loop session (no CL_STATE_DIR)  → allow
 *   - loop + human present (userIsTakingOver) → allow
 *   - loop + no human                         → deny + redirect
 *   - any error                               → allow
 *
 * Only fires for AskUserQuestion (the settings matcher scopes it), and
 * always exits 0 — a hook failure must never block a tool call.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_ASK_GRACE_SEC, afkActive, userIsTakingOver } from "./state.js";

function allow(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

function deny(reason: string): never {
    process.stdout.write(
        JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: reason,
            },
        }) + "\n",
    );
    process.exit(0);
}

try {
    // Drain stdin (Claude Code pipes the PreToolUse payload). We don't
    // need it — the matcher already scopes us to AskUserQuestion — but
    // reading avoids a broken pipe on the writer side.
    try {
        readFileSync(0, "utf8");
    } catch {
        /* no stdin available */
    }

    const sd = process.env.CL_STATE_DIR;
    // Not inside a loop → interactive session, a human can answer. Allow.
    if (!sd) allow();

    const redirect =
        "AskUserQuestion (multi-choice dialog) stalls the autonomous aiball loop — no human is in front to click an answer. " +
        "Post your question as an aiball ticket comment instead (ticket_reply on the relevant ticket); the conversation IS the channel. " +
        "When a human is present (interactive session) this dialog is allowed.";

    // #351: the human explicitly flagged AFK (the afk_key combo, e.g.
    // double-ESC) → they've stepped away even if they were just active.
    // Redirect immediately rather than stall on a dialog nobody will click.
    if (afkActive(sd)) deny(redirect);

    // #351: AskUserQuestion uses the longer ASK-grace (default 10 min), not
    // the 60s wake user-grace — a present-but-quiet human should still get
    // the dialog; only a silent timeout (departure) falls back to redirect.
    const graceSec = Math.max(
        0,
        Number(process.env.CL_ASK_GRACE_SEC ?? DEFAULT_ASK_GRACE_SEC),
    );
    if (userIsTakingOver(sd, graceSec)) allow();

    // Autonomous loop / human long-gone → the dialog would stall. Redirect.
    deny(redirect);
} catch {
    allow();
}
