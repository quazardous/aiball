// #324 e2e — tags consumers / state_human_word (#310, #328 checklist q:7f72a3):
// a loop agent pushes its 3-state presence word (stop/wait/loop) via
// PUT /api/consumers/:id/state → it's reflected on the consumers page
// (GET /api/consumers, field state_human_word). Plus the auth guards: a human
// can't push state (state badges are for loop agents), and an agent can only
// push its OWN consumer_id.
//
// Driven over HTTP against the shared daemon. NB: consumer state is GLOBAL (not
// project-scoped), so this scenario uses consumer ids unique to it
// ("tagscons-*") to avoid clobbering / being clobbered by other scenarios.
import { provision, provisionHuman, ok, fail, BASE } from "./lib.js";

const AGENT = "tagscons-agent";
const HUMAN = "tagscons-human";

async function putState(token: string, consumerId: string, body: Record<string, unknown>): Promise<{ code: number; body: Record<string, unknown> | null }> {
    const r = await fetch(`${BASE}/api/consumers/${encodeURIComponent(consumerId)}/state`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    const text = await r.text();
    return { code: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

async function consumerWord(token: string, consumerId: string): Promise<unknown> {
    const r = await fetch(`${BASE}/api/consumers`, { headers: { authorization: `Bearer ${token}` } });
    const text = await r.text();
    if (!r.ok) throw new Error(`GET /api/consumers → ${r.status}: ${text}`);
    const list = JSON.parse(text) as Array<Record<string, unknown>>;
    const me = list.find((c) => c.consumer_id === consumerId);
    if (!me) fail(`consumer ${consumerId} not found on the consumers page`);
    return me.state_human_word;
}

async function main(): Promise<void> {
    const tokAgent = provision(AGENT); // kind=agent → may push state
    const tokHuman = provisionHuman(HUMAN); // kind=human → state push forbidden

    // --- the 3 presence words round-trip onto the consumers page (#310). ---
    for (const word of ["stop", "wait", "loop"] as const) {
        const put = await putState(tokAgent, AGENT, { state: "busy", human_word: word });
        if (put.code !== 200) fail(`pushing human_word=${word} should be 200, got ${put.code} (${JSON.stringify(put.body)})`);
        if (put.body?.human_word !== word) fail(`state push response should echo human_word=${word}, got ${JSON.stringify(put.body)}`);
        const reflected = await consumerWord(tokAgent, AGENT);
        if (reflected !== word) fail(`consumers page should reflect state_human_word=${word}, got ${JSON.stringify(reflected)}`);
        ok(`state_human_word=${word} pushed → reflected on the consumers page`);
    }

    // --- an unknown word is ignored (not one of stop/wait/loop) → the last
    //     valid word ("loop") stays, never a bogus value. ---
    const bogus = await putState(tokAgent, AGENT, { state: "busy", human_word: "dancing" });
    if (bogus.code !== 200) fail(`a state push with an unknown human_word should still 200 (word ignored), got ${bogus.code}`);
    const afterBogus = await consumerWord(tokAgent, AGENT);
    if (afterBogus !== "loop") fail(`unknown human_word should be ignored (state_human_word stays "loop"), got ${JSON.stringify(afterBogus)}`);
    ok('unknown human_word ignored — state_human_word stays "loop" (no bogus value)');

    // --- guard: a human can't push state (badges are for loop agents). ---
    const humanTry = await putState(tokHuman, HUMAN, { state: "busy", human_word: "wait" });
    if (humanTry.code !== 403) fail(`a human pushing state should get 403, got ${humanTry.code} (${JSON.stringify(humanTry.body)})`);
    ok("guard — human state push rejected 403 (state push is for loop agents)");

    // --- guard: an agent can only push its OWN consumer_id. ---
    const spoof = await putState(tokAgent, "tagscons-someone-else", { state: "busy", human_word: "wait" });
    if (spoof.code !== 403) fail(`pushing another consumer's state should get 403, got ${spoof.code} (${JSON.stringify(spoof.body)})`);
    ok("guard — cross-consumer state push rejected 403 (own-state only)");

    ok("tags consumers — state_human_word (stop/wait/loop) reflected on the consumers page + auth guards (#328 q:7f72a3)");
    process.exit(0);
}

main().catch((e) => {
    console.error("scenario error:", e);
    process.exit(1);
});
