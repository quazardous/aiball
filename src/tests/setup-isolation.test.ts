// Verify the global test isolation (#738) — HOME / USERPROFILE /
// XDG_CONFIG_HOME are rerouted to a temp dir by `setup-isolation.ts`
// so no global config lookup leaks the developer's ambient state into
// the suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";

test("#738 isolation: HOME and friends point at a fresh temp dir", () => {
    const home = process.env.HOME;
    assert.ok(home, "HOME must be set by setup-isolation");
    assert.match(home, /aiball-test-iso-/, "HOME must be the isolated temp dir");
    assert.equal(process.env.USERPROFILE, home, "USERPROFILE must mirror HOME");
    assert.equal(
        process.env.XDG_CONFIG_HOME,
        join(home, ".config"),
        "XDG_CONFIG_HOME must be the isolated .config",
    );
    // Sanity : `os.homedir()` reads HOME on POSIX. Cached or not, it
    // must agree with the env so anything calling homedir() lands in
    // the isolated dir.
    assert.equal(homedir(), home);
});

test("#738 isolation: no leaked .aiball.yaml in the global config dir", () => {
    // The isolated dir is fresh — we never write into it. Confirm no
    // stray global config exists (would mean the setup picked an
    // already-populated path, defeating isolation).
    const xdg = process.env.XDG_CONFIG_HOME!;
    const globalConfig = join(xdg, "aiball", "config.yaml");
    assert.equal(existsSync(globalConfig), false);
});
