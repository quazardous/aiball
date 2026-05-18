#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop Stop hook (#B.63 TS port). Runs at the end of every
 * Claude turn inside a loop session. Writes `idle-since` so the
 * timer process knows claude is at the prompt waiting.
 *
 * Reads CL_STATE_DIR from the env that the wrapper baked into
 * `<state-dir>/env` and sourced before exec'ing claude. Exits 0
 * with `{}` on stdout = lets claude stop (the wake-up is the
 * timer's job).
 */
import { writeFileSync } from "node:fs";
import { idleMarkerPath } from "./state.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

try {
    const sd = process.env.CL_STATE_DIR;
    if (sd) {
        writeFileSync(idleMarkerPath(sd), new Date().toISOString() + "\n");
    }
    // Either way (no state-dir = hook fired outside a claude-loop
    // session) we always emit and exit 0. Never block claude.
} catch {
    /* swallow */
}
emit();
