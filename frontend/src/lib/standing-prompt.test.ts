/**
 * #1832 — the recall list, now shared by two entry points.
 *
 * The assertion that matters is that CLEARING the field never clears the
 * history: the instruction is typed on leaving and wiped on return, so without
 * recall every departure would be a rewrite from scratch — which is the whole
 * reason this list exists.
 */
import test from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
} as Storage;

const { readStandingPromptHistory, rememberStandingPrompt } = await import("./standing-prompt.js");

test("newest first, and re-using an entry moves it back to the top", () => {
    store.clear();
    rememberStandingPrompt("p", "debug léger");
    rememberStandingPrompt("p", "stabilité prod");
    rememberStandingPrompt("p", "debug léger");
    assert.deepEqual(readStandingPromptHistory("p"), ["debug léger", "stabilité prod"]);
});

test("clearing the field is a no-op on the history — the point of having one", () => {
    store.clear();
    rememberStandingPrompt("p", "debug léger");
    rememberStandingPrompt("p", "");
    rememberStandingPrompt("p", "   ");
    assert.deepEqual(readStandingPromptHistory("p"), ["debug léger"]);
});

test("history is per project — one project's note never suggests in another", () => {
    store.clear();
    rememberStandingPrompt("a", "note de a");
    assert.deepEqual(readStandingPromptHistory("b"), []);
});

test("a corrupted entry degrades to no suggestions, never to a crash", () => {
    store.clear();
    store.set("aiball.standingPrompt.history.p", "not json");
    assert.deepEqual(readStandingPromptHistory("p"), []);
});
