/**
 * #3923 — a wake typed into Claude, then Enter. Seen on helios: with three
 * background agents redrawing the footer, Claude read the phrase and the Enter
 * as one paste, the Enter became a new line, and the wake sat in the prompt.
 * What must hold:
 * - Enter waits until the phrase shows in the input box;
 * - an Enter swallowed as a new line is followed by one more;
 * - a normal Claude gets exactly one Enter;
 * - with no input box on screen, the old way: one Enter, no wait.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { typeAndSubmit, type ScreenSnapshot } from "./terminal-port.js";

const T = { pollMs: 5, minGapMs: 20, landMaxMs: 400, settleMs: 10, confirmMaxMs: 300 };
const RULE = "─".repeat(40);

/** A Claude-like screen: transcript, the input box, a footer. */
function fakeClaude(opts: { readLagMs?: number; swallowFirstEnter?: boolean; noBox?: boolean } = {}) {
    let input = "";
    let shown = "";
    let swallow = !!opts.swallowFirstEnter;
    const sent: string[] = [];
    const render = () => { setTimeout(() => { shown = input; }, opts.readLagMs ?? 0); };
    return {
        sent,
        submitted: [] as string[],
        inject(this: { submitted: string[] }, text: string): Promise<boolean> {
            sent.push(text);
            if (text === "\r") {
                if (swallow) { swallow = false; input += "\n"; }
                else { this.submitted.push(input.trim()); input = ""; }
            } else input += text;
            render();
            return Promise.resolve(true);
        },
        screen(): ScreenSnapshot {
            if (opts.noBox) return { text: `$ ${shown}`, cursor: null };
            const rows = shown.split("\n");
            const lines = ["● previous answer", RULE + " helios-claude ─", `❯ ${rows[0]}`, ...rows.slice(1).map((r) => `  ${r}`), RULE, "  ○ general-purpose  Watching disk  1h 8m"];
            const last = rows.length - 1;
            return { text: lines.join("\n"), cursor: { x: (last === 0 ? 2 : 2) + rows[last].length, y: 2 + last } };
        },
    };
}

test("a normal Claude gets one Enter, once the phrase shows", async () => {
    const c = fakeClaude();
    const logs: string[] = [];
    assert.equal(await typeAndSubmit({ inject: (x) => c.inject(x), screen: () => c.screen(), log: (m) => logs.push(m) }, "wake up", T), true);
    assert.deepEqual(c.sent, ["wake up", "\r"]);
    assert.deepEqual(c.submitted, ["wake up"]);
    assert.deepEqual(logs, []);
});

test("a slow reader: Enter waits for the phrase to show, past the old blind gap", async () => {
    const c = fakeClaude({ readLagMs: 120 });
    const order: string[] = [];
    const io = {
        inject: (x: string) => { order.push(`${x === "\r" ? "enter" : "text"}@${c.screen().text.includes("❯ slow") ? "shown" : "unseen"}`); return c.inject(x); },
        screen: () => c.screen(),
        log: () => {},
    };
    assert.equal(await typeAndSubmit(io, "slow", T), true);
    assert.deepEqual(order, ["text@unseen", "enter@shown"]);
});

test("an Enter swallowed as a new line is followed by one more, and says so", async () => {
    const c = fakeClaude({ swallowFirstEnter: true });
    const logs: string[] = [];
    assert.equal(await typeAndSubmit({ inject: (x) => c.inject(x), screen: () => c.screen(), log: (m) => logs.push(m) }, "@helios-claude: what changed on the bench box", T), true);
    assert.deepEqual(c.sent, ["@helios-claude: what changed on the bench box", "\r", "\r"]);
    assert.deepEqual(c.submitted, ["@helios-claude: what changed on the bench box"]);
    assert.match(logs.join("\n"), /submit retried/);
});

test("each Enter is announced first, so its submit reads as the loop's", async () => {
    const c = fakeClaude({ swallowFirstEnter: true });
    const seen: string[] = [];
    const io = {
        inject: (x: string) => { seen.push(x === "\r" ? "enter" : "text"); return c.inject(x); },
        screen: () => c.screen(),
        log: () => {},
        beforeEnter: () => { seen.push("mark"); },
    };
    assert.equal(await typeAndSubmit(io, "x", T), true);
    assert.deepEqual(seen, ["text", "mark", "enter", "mark", "enter"]);
});

test("no input box on screen: the old way, one Enter", async () => {
    const c = fakeClaude({ noBox: true });
    const logs: string[] = [];
    const t0 = Date.now();
    assert.equal(await typeAndSubmit({ inject: (x) => c.inject(x), screen: () => c.screen(), log: (m) => logs.push(m) }, "x", T), true);
    assert.deepEqual(c.sent, ["x", "\r"]);
    assert.ok(Date.now() - t0 < T.landMaxMs, "no wait on a box that is not there");
    assert.deepEqual(logs, []);
});

test("a failed write stops there", async () => {
    const sent: string[] = [];
    const io = { inject: async (x: string) => { sent.push(x); return false; }, screen: () => ({ text: "", cursor: null }), log: () => {} };
    assert.equal(await typeAndSubmit(io, "x", T), false);
    assert.deepEqual(sent, ["x"]);
});
