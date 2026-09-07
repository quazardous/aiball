// #2099 — the platform → tag map.
//
// This is the guard that lets the daemon create a tag from client input at all.
// The catalogue is otherwise curated by hand, so what has to hold is that a
// client can only ever DESIGNATE one of three names, never propose one. Every
// case below is really asking the same question: can anything a caller sends
// end up as a tag we didn't choose?
import test from "node:test";
import assert from "node:assert/strict";
import { PLATFORM_TAG_PREFIX, platformTagName } from "./platform-tag.js";

test("the three platforms aiball runs on get their tag", () => {
    assert.equal(platformTagName("linux"), "os:linux");
    assert.equal(platformTagName("win32"), "os:win");
    assert.equal(platformTagName("darwin"), "os:mac");
});

test("Node's spelling and aiball's land on the same tag", () => {
    // `process.platform` says win32/darwin; the catalogue and david both say
    // win/mac. Accepting one spelling only is how you end up with two
    // near-identical tags nobody meant to create.
    assert.equal(platformTagName("win"), platformTagName("win32"));
    assert.equal(platformTagName("windows"), "os:win");
    assert.equal(platformTagName("mac"), platformTagName("darwin"));
    assert.equal(platformTagName("macos"), "os:mac");
});

test("case and whitespace don't make a second tag", () => {
    assert.equal(platformTagName("  Linux \n"), "os:linux");
    assert.equal(platformTagName("WIN32"), "os:win");
});

test("nothing else is nameable — that is the whole guarantee", () => {
    // A plausible platform is still a no: the map is the authority, not the
    // caller. Otherwise "create a tag on first use" would mean "any client can
    // write to the catalogue".
    for (const raw of ["freebsd", "sunos", "aix", "android", "os:win", "urgent", "../../etc"]) {
        assert.equal(platformTagName(raw), null, `${raw} must not map`);
    }
});

test("absent, empty or malformed input maps to nothing", () => {
    // A client that never sends the header files tickets exactly as before.
    assert.equal(platformTagName(null), null);
    assert.equal(platformTagName(undefined), null);
    assert.equal(platformTagName(""), null);
    assert.equal(platformTagName("   "), null);
});

test("every name it can produce stays inside the prefix it owns", () => {
    for (const raw of ["linux", "win32", "darwin", "win", "mac", "macos", "windows"]) {
        const name = platformTagName(raw);
        assert.ok(name && name.startsWith(PLATFORM_TAG_PREFIX), `${raw} → ${name}`);
    }
});
