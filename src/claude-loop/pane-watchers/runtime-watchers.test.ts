// #845 Phase B — runtime-zone watcher tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BusyWatcher, InterruptedWatcher, PromptWatcher, NotLoggedInWatcher, ApiUnreachableWatcher } from "./runtime-watchers.js";
import { ErrorWatcher } from "./error-watcher.js";

const CTX = { nowMs: 0 };

test("PromptWatcher: matches `Claude Code v` splash", () => {
    const w = new PromptWatcher();
    assert.equal(w.observe("Welcome to Claude Code v1.2.3", CTX).visible, true);
});

test("PromptWatcher: matches `❯ ` chevron prompt", () => {
    const w = new PromptWatcher();
    assert.equal(w.observe("output above\n❯ ", CTX).visible, true);
});

test("PromptWatcher: matches `> ` at line start", () => {
    const w = new PromptWatcher();
    assert.equal(w.observe("> something", CTX).visible, true);
});

test("PromptWatcher: rejects pane without prompt markers", () => {
    const w = new PromptWatcher();
    assert.equal(w.observe("✻ Working…", CTX).visible, false);
});

test("BusyWatcher: matches `esc to interrupt` in footer", () => {
    const w = new BusyWatcher();
    assert.equal(
        w.observe("✻ Crunching…\n  ⏵⏵ auto mode on · esc to interrupt", CTX).visible,
        true,
    );
});

test("BusyWatcher: rejects idle pane", () => {
    const w = new BusyWatcher();
    assert.equal(w.observe("❯ \n  ⏵⏵ auto mode on", CTX).visible, false);
});

test("InterruptedWatcher: matches the `interrupted by user` near-prompt marker", () => {
    const w = new InterruptedWatcher();
    const pane = "● doing stuff\n  ⎿ Interrupted by user\n────\n❯ \n  ⏵⏵ auto mode on";
    assert.equal(w.observe(pane, CTX).visible, true);
});

test("InterruptedWatcher: false on a normal idle pane", () => {
    const w = new InterruptedWatcher();
    assert.equal(w.observe("❯ \n  ⏵⏵ auto mode on", CTX).visible, false);
});

// ---------------------------------------------------------------------------
//  NotLoggedInWatcher (#1072)
// ---------------------------------------------------------------------------

test("NotLoggedInWatcher: matches `Not logged in` banner", () => {
    const w = new NotLoggedInWatcher();
    assert.equal(w.observe("Not logged in · Please run /login", CTX).visible, true);
});

test("NotLoggedInWatcher: matches the `Run /login` and session-expired variants", () => {
    const w = new NotLoggedInWatcher();
    assert.equal(w.observe("Not logged in · Run /login", CTX).visible, true);
    const w2 = new NotLoggedInWatcher();
    assert.equal(
        w2.observe("Your session has expired. Please run /login to sign in again.", CTX).visible,
        true,
    );
});

test("NotLoggedInWatcher: false on a normal logged-in pane", () => {
    const w = new NotLoggedInWatcher();
    assert.equal(w.observe("❯ \n  ⏵⏵ auto mode on", CTX).visible, false);
});

test("NotLoggedInWatcher: no self-trip on an injected wake-CTA prompt line quoting the banner", () => {
    const w = new NotLoggedInWatcher();
    // Le wake-CTA (ligne prompt `>`) peut citer un titre de ticket contenant
    // le banner mot pour mot — footerOf drop les lignes prompt.
    const pane = "> look #1119: claude-loop reste en claude not logged in · Please run /login. Triage.\n  ⏵⏵ auto mode on";
    assert.equal(w.observe(pane, CTX).visible, false);
});

test("NotLoggedInWatcher: no self-trip on conversation prose mentioning the words", () => {
    const w = new NotLoggedInWatcher();
    // Claude qui DISCUTE du bug (loose mention, pas la forme banner exacte).
    const pane = "● The watcher matched 'Not logged in' and 'Please run /login' as loose substrings.";
    assert.equal(w.observe(pane, CTX).visible, false);
});

test("NotLoggedInWatcher: begin fires when the banner appears", () => {
    const w = new NotLoggedInWatcher();
    let beginCount = 0;
    w.on("begin", () => { beginCount++; });
    w.observe("❯ \n  ⏵⏵ auto mode on", CTX);
    w.observe("Not logged in · Please run /login", CTX);
    assert.equal(beginCount, 1);
});

// ---------------------------------------------------------------------------
//  ApiUnreachableWatcher (#1116 Slice 1)
// ---------------------------------------------------------------------------

test("ApiUnreachableWatcher: matches the retry banner (counter + connection keyword)", () => {
    const w = new ApiUnreachableWatcher();
    const pane = "✻ Working…\nUnable to connect to API (ConnectionRefused) · Retrying in 0s · attempt 6/10";
    assert.equal(w.observe(pane, CTX).visible, true);
});

test("ApiUnreachableWatcher: false on a normal idle pane", () => {
    const w = new ApiUnreachableWatcher();
    assert.equal(w.observe("❯ \n  ⏵⏵ auto mode on", CTX).visible, false);
});

test("ApiUnreachableWatcher: no self-trip on the retry counter alone (no connection keyword)", () => {
    const w = new ApiUnreachableWatcher();
    // A benign line mentioning "attempt 3/5" without any connection/retry banner
    // must NOT latch (guards against conversation text).
    assert.equal(w.observe("● test run: attempt 3/5 passed", CTX).visible, false);
});

test("ApiUnreachableWatcher: no self-trip on connection prose without the counter", () => {
    const w = new ApiUnreachableWatcher();
    // Claude discussing the ticket : mentions ConnectionRefused / Retrying but no
    // live "attempt N/M" counter → not the actual retry pane.
    const pane = "● The ticket is about ConnectionRefused and Retrying in the pane.";
    assert.equal(w.observe(pane, CTX).visible, false);
});

test("ApiUnreachableWatcher: no self-trip on an injected wake-CTA prompt line (#1119 lesson)", () => {
    const w = new ApiUnreachableWatcher();
    // The loop-injected wake prompt (a `>` line) can quote the whole banner ;
    // footerOf drops prompt-input lines so it can't latch the flag.
    const pane = "> look #1116: Unable to connect to API · Retrying · attempt 6/10. Triage.\n  ⏵⏵ auto mode on";
    assert.equal(w.observe(pane, CTX).visible, false);
});

test("ApiUnreachableWatcher: begin fires once when the retry banner appears", () => {
    const w = new ApiUnreachableWatcher();
    let beginCount = 0;
    w.on("begin", () => { beginCount++; });
    w.observe("❯ \n  ⏵⏵ auto mode on", CTX);
    w.observe("Unable to connect to API (ConnectionRefused) · Retrying in 2s · attempt 4/10", CTX);
    assert.equal(beginCount, 1);
});

// ---------------------------------------------------------------------------
//  ErrorWatcher — id-typed state
// ---------------------------------------------------------------------------

test("ErrorWatcher: clean pane → null", () => {
    const w = new ErrorWatcher();
    assert.equal(w.observe("normal idle pane", CTX).errorId, null);
});

test("ErrorWatcher: begin fires on null → error", () => {
    const w = new ErrorWatcher();
    let beginCount = 0;
    w.on("begin", () => { beginCount++; });
    w.observe("normal idle pane", CTX);
    // `Rate limited` is one of error-backoff.ts's pinned patterns.
    w.observe("API Error: Server is temporarily limiting requests", CTX);
    assert.equal(w.snapshot().errorId, "rate-limit");
    assert.equal(beginCount, 1);
});

test("ErrorWatcher: end fires when error clears", () => {
    const w = new ErrorWatcher();
    let endCount = 0;
    w.on("end", () => { endCount++; });
    w.observe("API Error: Server is temporarily limiting requests", CTX);
    w.observe("normal idle pane", CTX);
    assert.equal(w.snapshot().errorId, null);
    assert.equal(endCount, 1);
});

test("ErrorWatcher: id-to-id transition fires change only, not begin/end", () => {
    const w = new ErrorWatcher();
    let beginCount = 0; let endCount = 0; let changeCount = 0;
    w.on("begin", () => { beginCount++; });
    w.on("end", () => { endCount++; });
    w.on("change", () => { changeCount++; });
    w.observe("API Error: Server is temporarily limiting requests", CTX);
    w.observe("API Error: Overloaded", CTX);
    assert.equal(w.snapshot().errorId, "overloaded");
    assert.equal(beginCount, 1);   // only initial null → rate-limit
    assert.equal(endCount, 0);     // never went back to null
    assert.equal(changeCount, 2);  // 2 transitions (null→rate-limit, rate-limit→overloaded)
});
