/**
 * Test isolation setup (#738) — pinned via `node --import` BEFORE any
 * test module loads. Reroutes `HOME` / `USERPROFILE` / `XDG_CONFIG_HOME`
 * to a fresh temp dir so any code path reading a global config
 * (`~/.config/aiball/config.yaml` via `globalConfigPath`, `loadProxy`,
 * `assignWindowSec`, `getConfig`, …) sees a clean default instead of
 * the developer's ambient setup.
 *
 * Without this, `npm test` on a box with a real `proxy:` block in the
 * global config flipped the app into PROXY MODE and forwarded the API
 * tests to the live remote (404/401 noise on a clean miss ; SILENT
 * MUTATION on a permissive remote). David : "tout doit etre isolé pour
 * l'env de test".
 *
 * `AIBALL_HOME` (data dir) stays per-test : each suite that needs a DB
 * already `mkdtempSync`-es its own (e.g. `src/proxy-ws-pane.test.ts:20`,
 * `src/messages-close.test.ts:16`). The isolation here only addresses
 * the CONFIG side.
 *
 * No cleanup — the OS GC's `tmpdir()` on its own schedule. The dir is
 * empty (we don't write anything in it ; the daemon would, but the
 * tests' `AIBALL_HOME` overrides redirect daemon state elsewhere).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolatedHome = mkdtempSync(join(tmpdir(), "aiball-test-iso-"));
process.env.HOME = isolatedHome;
// Windows : `os.homedir()` falls back to USERPROFILE when HOME is unset
// but reads HOME first on POSIX. Cover both so the suite runs the same
// on Linux / macOS / Windows.
process.env.USERPROFILE = isolatedHome;
// `globalConfigPath()` (src/autopoll/config.ts:38) uses XDG_CONFIG_HOME
// when set, else `$HOME/.config`. Pin both so the global config lookup
// lands in the empty isolated dir.
process.env.XDG_CONFIG_HOME = join(isolatedHome, ".config");

// #3241 — the rest of what reaches a live daemon or a live loop, for every
// test run through this setup (`npm test`, Docker):
// - AIBALL_SOCK empty: a client call can never reach the live daemon's socket
//   (an exported one used to win over a test's own AIBALL_HOME);
// - a fresh AIBALL_HOME, CLAUDE_LOOP_STATE_ROOT and TMUX_TMPDIR by default (a
//   suite may still set its own): no test reads or writes the live board, the
//   live loops' state, or the user's tmux server;
// - the identity a loop's shell exports (CL_*, AIBALL_AGENT/PROJECT/CWD…)
//   dropped: a test run from an agent's Bash is not that agent. What a run
//   sets on purpose stays: the binaries to use and the test switches.
const KEEP = new Set(["CL_SESSION_HOST_BIN", "CL_PROXY_BIN", "CL_CLAUDE_CMD"]);
const INHERITED = ["AIBALL_AGENT", "AIBALL_PROJECT", "AIBALL_CWD", "AIBALL_PROJECT_CWD", "AIBALL_SESSION_KEY", "AIBALL_SESSION_MODE", "AIBALL_URL", "AIBALL_TOKEN"];
for (const k of Object.keys(process.env)) {
    if ((k.startsWith("CL_") && !KEEP.has(k)) || INHERITED.includes(k)) delete process.env[k];
}
// #3389 — a developer's checkout holds a git-ignored `.aiball.yaml` naming its
// agent; CI and Docker have none. The commands the tests launch from the
// checkout, under identities of their own, must not be refused here and pass
// there. The tests of the rule itself take this off.
process.env.AIBALL_ALLOW_FOREIGN_AGENT = "1";
process.env.AIBALL_SOCK = "";
process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-test-home-"));
process.env.CLAUDE_LOOP_STATE_ROOT = mkdtempSync(join(tmpdir(), "aiball-test-loops-"));
process.env.TMUX_TMPDIR = mkdtempSync(join(tmpdir(), "aiball-test-tmux-"));
delete process.env.TMUX;
