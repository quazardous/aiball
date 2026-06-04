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
