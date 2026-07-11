#!/usr/bin/env -S npx --no-install tsx
/**
 * Hook dispatcher — the single CLI entry for every Claude Code hook a loop
 * installs. `claude` invokes `hook-entry.ts <EventName>`; we look the event up
 * in the registry and dynamically import its handler module, which runs its
 * own logic (emit to the timer, or produce a PreToolUse verdict) and exits.
 *
 * Keeping ONE registered script means adding a hook is a registry entry + a
 * handler module — never a new script wired into the settings JSON.
 *
 * Fail-open: an unknown or missing event emits `{}` and exits 0, so a stale
 * registration can never block claude's turn.
 */
import { HOOKS } from "./registry.js";

const event = process.argv[2];
const spec = event ? HOOKS.find((h) => h.event === event) : undefined;
if (!spec) {
    process.stdout.write("{}\n");
    process.exit(0);
}
// The handler module runs its logic on import (they are side-effecting scripts)
// and exits the process itself.
await import(spec.module);
