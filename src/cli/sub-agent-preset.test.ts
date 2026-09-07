/**
 * The preset decides an agent's standing in a project, so the cases that
 * matter are the two ways it can be wrong: filling too little (the bug this
 * fixes — `no_claim` without `role`, which left the agent an owner and fed it
 * the whole project backlog) and filling too much (overruling a flag the user
 * actually typed).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveSubAgentPreset } from "./sub-agent-preset.js";

const derive = () => "derived-name";
const never = () => {
    throw new Error("derive() must not be called when a name was given");
};

test("a bare --sub-agent is assignment-only AND a follower", () => {
    // Both halves, together. `no_claim` alone was the bug: it shuts the claim
    // door while `subscriptionRoleFor` still maps a missing role to `owner`,
    // and default-scope events fan out to project owners.
    assert.deepEqual(resolveSubAgentPreset({}, true, derive), {
        consumer: "derived-name",
        noClaim: true,
        role: "crew",
    });
});

test("the name typed after the flag is used verbatim, without deriving one", () => {
    assert.deepEqual(resolveSubAgentPreset({}, "  worker-a  ", never), {
        consumer: "worker-a",
        noClaim: true,
        role: "crew",
    });
});

test("an explicit --agent wins over both the flag's name and the derivation", () => {
    assert.equal(
        resolveSubAgentPreset({ consumer: "chosen" }, "ignored", never).consumer,
        "chosen",
    );
});

test("an explicit --role is not overruled by the preset", () => {
    // Someone who asks for a lead sub-agent gets one; the preset fills blanks.
    assert.equal(resolveSubAgentPreset({ role: "lead" }, true, derive).role, "lead");
});

test("an explicit --no-claim false is not overruled either", () => {
    // `false` is a value, not an absence — `??` must not treat it as unset.
    assert.equal(resolveSubAgentPreset({ noClaim: false }, true, derive).noClaim, false);
});

test("re-running on a project that already has a name keeps it", () => {
    // A consumer id is an identity the daemon holds rows against — tickets
    // authored, subscriptions, assignment history. Deriving a fresh one on a
    // re-run would orphan all of it, silently.
    assert.equal(
        resolveSubAgentPreset({ yamlConsumer: "already-there" }, true, never).consumer,
        "already-there",
    );
});

test("but a name typed on this command line still wins over the existing one", () => {
    // #612's rule: init respects what is already set UNLESS a flag says
    // otherwise. Both ways of typing a name count as saying otherwise.
    assert.equal(
        resolveSubAgentPreset({ yamlConsumer: "old" }, "new-name", never).consumer,
        "new-name",
    );
    assert.equal(
        resolveSubAgentPreset({ consumer: "flagged", yamlConsumer: "old" }, true, never).consumer,
        "flagged",
    );
});

test("a blank or absent yaml name is not mistaken for a decision", () => {
    for (const empty of [null, undefined, "", "   "]) {
        assert.equal(
            resolveSubAgentPreset({ yamlConsumer: empty }, true, derive).consumer,
            "derived-name",
        );
    }
});

test("a blank name after the flag falls back to the derivation", () => {
    // `--sub-agent ""` and `--sub-agent "   "` are the bare flag in disguise;
    // an empty consumer would hand the loop the global default identity and
    // let two agents share one.
    for (const blank of ["", "   "]) {
        assert.equal(resolveSubAgentPreset({}, blank, derive).consumer, "derived-name");
    }
});
