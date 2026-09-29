// #3299 — the restore names how to stop and start the daemon on this platform:
// on Windows the tray supervises it, so the tray is quit, never `systemctl`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { daemonStopStart } from "./backup.js";

test("Windows: quit the tray, then start it again; no systemctl", () => {
    const s = daemonStopStart("win32");
    assert.match(s.stop, /Quit aiball/);
    assert.match(s.start, /Start-ScheduledTask -TaskName aiball-daemon/);
    assert.doesNotMatch(s.stop + s.start, /systemctl/);
});

test("Linux and macOS: the systemd user unit", () => {
    for (const p of ["linux", "darwin"] as const) {
        assert.deepEqual(daemonStopStart(p), { stop: "systemctl --user stop aiball", start: "systemctl --user start aiball" });
    }
});
