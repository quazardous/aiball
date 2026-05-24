import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #398: loadLaunchers parses + validates the global config `launchers:` list.
// loadLaunchers reads globalConfigPath() which honours XDG_CONFIG_HOME → point
// it at a temp dir so we never touch the real config.
function withConfig(yaml: string, fn: () => void): void {
    const dir = mkdtempSync(join(tmpdir(), "aiball-launchers-"));
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    mkdirSync(join(dir, "aiball"), { recursive: true });
    writeFileSync(join(dir, "aiball", "config.yaml"), yaml, "utf8");
    try {
        fn();
    } finally {
        if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prev;
        rmSync(dir, { recursive: true, force: true });
    }
}

test("#398 loadLaunchers: parses valid entries, applies label default", async () => {
    const { loadLaunchers } = await import("./launchers.js");
    withConfig(
        [
            "launchers:",
            "  - id: chrome",
            "    label: Chrome",
            "    cmd: google-chrome-stable",
            "    args: ['--new-window']",
            "    icon: pi-google",
            "  - id: term",          // no label → defaults to id
            "    cmd: alacritty",
        ].join("\n"),
        () => {
            const ls = loadLaunchers();
            assert.equal(ls.length, 2);
            assert.deepEqual(ls[0], { id: "chrome", label: "Chrome", cmd: "google-chrome-stable", args: ["--new-window"], icon: "pi-google" });
            assert.equal(ls[1].label, "term"); // label defaulted to id
        },
    );
});

test("#398 loadLaunchers: drops entries missing id/cmd + dedups by id", async () => {
    const { loadLaunchers, getLauncher } = await import("./launchers.js");
    withConfig(
        [
            "launchers:",
            "  - id: ok",
            "    cmd: foo",
            "  - id: noCmd",          // dropped (no cmd)
            "  - cmd: noId",          // dropped (no id)
            "  - id: ok",             // dropped (duplicate id)
            "    cmd: bar",
        ].join("\n"),
        () => {
            const ls = loadLaunchers();
            assert.deepEqual(ls.map((l) => l.id), ["ok"]);
            assert.equal(getLauncher("ok")?.cmd, "foo"); // first wins
            assert.equal(getLauncher("nope"), null);
        },
    );
});

test("#398 loadLaunchers: no launchers block / no file → empty list", async () => {
    const { loadLaunchers } = await import("./launchers.js");
    withConfig("proxy:\n  url: http://x\n", () => {
        assert.deepEqual(loadLaunchers(), []);
    });
});
