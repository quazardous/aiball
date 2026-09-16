// #2653 — the commits under a comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitsView } from "./commentCommits";
import { resolveCommitUrl } from "./upstream-providers";

const noUrl = () => null;

test("absent, none, and a list with credit or reason", () => {
    assert.deepEqual(commitsView(null, noUrl), { state: "absent" });
    assert.deepEqual(commitsView(JSON.stringify({ handback: true }), noUrl), { state: "absent" }, "a comment that never said");
    assert.deepEqual(commitsView(JSON.stringify({ commits: null }), noUrl), { state: "none" });
    const v = commitsView(JSON.stringify({ commits: [
        { sha: "9e32067f2ad96464e413b38f56885d8ffbb94fab", minutes: 30, reason: null },
        { sha: "deadbeef", minutes: 0, reason: "older than 48 h" },
    ] }), noUrl);
    assert.equal(v.state, "list");
    if (v.state !== "list") return;
    assert.deepEqual(v.chips.map((c) => [c.short, c.credit, c.earned]), [["9e32067", "+30 min", true], ["deadbee", "older than 48 h", false]]);
    assert.match(v.chips[0].title, /click to copy the SHA/);
    assert.doesNotMatch(v.chips[0].title, /credit|min/, "#2663 no score in what is shown");
    assert.deepEqual(commitsView("{broken", noUrl), { state: "absent" });
});

test("a linked GitHub repository turns each chip into a link; no binding, no link", () => {
    const bindings = [{ kind: "github", ref: "github:quazardous/aiball", default: true }];
    assert.equal(resolveCommitUrl("9e32067", bindings), "https://github.com/quazardous/aiball/commit/9e32067");
    assert.equal(resolveCommitUrl("9e32067", []), null);
    assert.equal(resolveCommitUrl("not a sha", bindings), null);
    const v = commitsView(JSON.stringify({ commits: [{ sha: "9e32067", minutes: 2, reason: null }] }), (sha) => resolveCommitUrl(sha, bindings));
    assert.ok(v.state === "list" && v.chips[0].url === "https://github.com/quazardous/aiball/commit/9e32067");
    assert.ok(v.state === "list" && !/copy/.test(v.chips[0].title));
});
