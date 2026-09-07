// #2091 — the derived sub-agent name.
//
// The property that matters is legibility: someone reading a ticket comment
// should know which machine wrote it. Second comes never returning nothing —
// an empty derivation would silently hand the loop the global default identity
// and let two agents share a name.
import test from "node:test";
import assert from "node:assert/strict";
import { deriveSubAgentName } from "./sub-agent-name.js";

test("project plus host, which is the whole point", () => {
    assert.equal(
        deriveSubAgentName({ project: "jobbox", dirBase: "jbx", host: "classy" }),
        "jobbox-classy",
    );
});

test("the directory stands in when there is no project yet", () => {
    assert.equal(
        deriveSubAgentName({ dirBase: "BookShepherd", host: "classy" }),
        "BookShepherd-classy",
    );
});

test("case is preserved — a project name belongs to the person who chose it", () => {
    assert.equal(deriveSubAgentName({ project: "m2m-bs", dirBase: "x", host: "papy" }), "m2m-bs-papy");
});

test("no host: say it is a sub rather than pretend to be specific", () => {
    assert.equal(deriveSubAgentName({ project: "jobbox", dirBase: "jbx" }), "jobbox-sub");
    assert.equal(deriveSubAgentName({ project: "jobbox", dirBase: "jbx", host: "  " }), "jobbox-sub");
});

test("a host that repeats the project adds nothing", () => {
    // `aiball` on the host `aiball` would read as a stutter, not a location.
    assert.equal(deriveSubAgentName({ project: "aiball", dirBase: "x", host: "aiball" }), "aiball-sub");
});

test("anything that would need quoting is flattened", () => {
    assert.equal(
        deriveSubAgentName({ project: "my project!", dirBase: "x", host: "win box" }),
        "my-project-win-box",
    );
    assert.equal(
        deriveSubAgentName({ project: "--weird--", dirBase: "x", host: "h" }),
        "weird-h",
    );
});

test("it never comes back empty", () => {
    assert.equal(deriveSubAgentName({ project: "", dirBase: "", host: "" }), "aiball-sub");
    assert.equal(deriveSubAgentName({ project: "///", dirBase: "!!!", host: "???" }), "aiball-sub");
});
