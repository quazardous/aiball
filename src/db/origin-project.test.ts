// #2070 — the origin-project rule.
//
// The case that motivated it: an agent owning one project filed ten tickets,
// three of them next door. One of the three was a deliberate cross-project
// announcement and entirely right; two were mistakes. Nothing told them apart,
// because filing next door and filing next door BY MISTAKE looked identical.
//
// So what these pin hardest is where the rule stays SILENT. A false "from X"
// badge is worse than none: a missing mark reads as ordinary, while a wrong one
// sends the reader looking for a relationship that does not exist.
import test from "node:test";
import assert from "node:assert/strict";
import { originProjectFor } from "./origin-project.js";

const owner = (project: string) => ({ project, role: "owner" });
const follower = (project: string) => ({ project, role: "follower" });

test("filing into your own project marks nothing", () => {
    assert.equal(originProjectFor("jobbox", [owner("jobbox")]), null);
    assert.equal(originProjectFor("jobbox", [owner("jobbox"), follower("aiball")]), null);
});

test("filing next door names where you came from", () => {
    // The real shape: jobbox-claude owns `jobbox` alone and filed into
    // BookShepherd, where it has no role at all.
    assert.equal(originProjectFor("BookShepherd", [owner("jobbox")]), "jobbox");
});

test("a project you only follow is still next door", () => {
    // Following a project is not belonging to it — you watch it, you don't
    // maintain it, and a ticket you file there comes from somewhere else.
    assert.equal(originProjectFor("aiball", [owner("jobbox"), follower("aiball")]), null);
    assert.equal(originProjectFor("skybot", [owner("jobbox"), follower("aiball")]), "jobbox");
});

test("a follower-only consumer with one subscription still has an origin", () => {
    assert.equal(originProjectFor("skybot", [follower("aiball")]), "aiball");
});

test("no subscriptions at all → silence, not a guess", () => {
    // A brand-new agent filing its first ticket, before anything subscribed it.
    // Guessing here would brand an ordinary deposit as foreign.
    assert.equal(originProjectFor("jobbox", []), null);
});

test("an ambiguous home → silence, not a guess", () => {
    // Two owner roles, or several follower-only subscriptions: there is no
    // single place this came from, and inventing one is the failure mode this
    // whole ticket is about.
    assert.equal(originProjectFor("skybot", [owner("jobbox"), owner("aiball")]), null);
    assert.equal(originProjectFor("skybot", [follower("jobbox"), follower("aiball")]), null);
});

test("an owner role wins over followers when picking the home", () => {
    assert.equal(
        originProjectFor("skybot", [follower("aiball"), owner("jobbox"), follower("m2m")]),
        "jobbox",
    );
});

test("a missing or unknown role is treated as a plain subscription", () => {
    assert.equal(originProjectFor("skybot", [{ project: "jobbox" }]), "jobbox");
    assert.equal(originProjectFor("skybot", [{ project: "jobbox", role: null }]), "jobbox");
});

test("an empty target never marks anything", () => {
    assert.equal(originProjectFor("", [owner("jobbox")]), null);
});
