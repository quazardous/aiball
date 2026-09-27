/**
 * `aiball autopoll` command group (carved out of cli.ts in #B.213
 * phase 3.E on 2026-05-19). Behavior-preserving move.
 *
 * Pilots per-project autopoll knobs by editing the nearest
 * `.aiball.yaml` (walking up from cwd). Subcommands: init, show,
 * enable, disable, tone, throttle, volatile, backlog.
 *
 * Exposed entry point: `registerAutopollCommands(program)`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatDuration, parseDuration } from "../config/duration.js";
import type { Command } from "commander";
import {
    die,
    fmtAutopollShow,
    gOpts,
    out,
    userCwd,
} from "./_helpers.js";

async function setAutopollField(key: string, value: unknown, replaces: string[] = []): Promise<void> {
    const { findConfigUpwards, CONFIG_FILENAME } = await import("../autopoll/config.js");
    const yamlMod = await import("yaml");
    let path = findConfigUpwards(userCwd());
    if (!path) {
        // Bootstrap: create a minimal .aiball.yaml at cwd so the user
        // doesn't have to run init separately.
        path = join(userCwd(), CONFIG_FILENAME);
        writeFileSync(path, "autopoll: {}\n");
        process.stdout.write(`created ${path}\n`);
    }
    const src = readFileSync(path, "utf8");
    const doc = yamlMod.parseDocument(src);
    if (!doc.has("autopoll")) doc.set("autopoll", { [key]: value });
    else doc.setIn(["autopoll", key], value);
    // #3138 — the key it renamed goes: two spellings would disagree.
    for (const old of replaces) if (doc.hasIn(["autopoll", old])) doc.deleteIn(["autopoll", old]);
    writeFileSync(path, doc.toString());
    process.stdout.write(`${path}: autopoll.${key} = ${JSON.stringify(value)}\n`);
}

export function registerAutopollCommands(program: Command): void {
    const autopoll = program
        .command("autopoll")
        .description(
            "Manage the per-project autopoll hook (Stop → drain pings). Operates on the closest .aiball.yaml walking up from cwd.",
        );

    // #600 david `483um7` — `aiball autopoll init` killed : `aiball init`
    // (and `claude-loop init`, the daily-driver) already write the
    // `.aiball.yaml` autopoll block. Autopoll est project-scope ; le
    // standalone init faisait double emploi.
    autopoll
        .command("init")
        .description("(removed in 0.27) — use `claude-loop init` (or `aiball init`)")
        .allowExcessArguments(true)
        .action(() => {
            die("`aiball autopoll init` was removed — use `claude-loop init` (or `aiball init`) ; both write .aiball.yaml with the autopoll block. #600");
        });

    autopoll
        .command("show")
        .description("Print resolved autopoll settings for cwd")
        .action(async (_opts, cmd) => {
            const { loadConfig } = await import("../autopoll/config.js");
            const cfg = loadConfig(userCwd());
            const payload = {
                config_path: cfg.configPath,
                autopoll: cfg.autopoll,
                consumer: cfg.consumer,
            };
            out(payload, gOpts(cmd), fmtAutopollShow);
        });

    autopoll
        .command("enable")
        .description("Set autopoll.enabled = true in .aiball.yaml")
        .action(async () => setAutopollField("enabled", true));

    autopoll
        .command("disable")
        .description("Set autopoll.enabled = false in .aiball.yaml")
        .action(async () => setAutopollField("enabled", false));

    autopoll
        .command("tone <value>")
        .description("Set autopoll.tone (hint | directive | imperative)")
        .action(async (value: string) => {
            if (value !== "hint" && value !== "directive" && value !== "imperative") {
                die(`unknown tone '${value}' (expected hint | directive | imperative)`);
            }
            await setAutopollField("tone", value);
        });

    autopoll
        .command("throttle <duration>")
        .description("Set autopoll.throttle: a duration (90s, 15m, 1h30m; a bare integer is seconds; 0 = off)")
        .action(async (duration: string) => {
            const n = parseDuration(duration);
            if (n === null) die(`throttle is a duration (90s, 15m, 1h30m…), got '${duration}'`);
            await setAutopollField("throttle", formatDuration(n), ["throttle_seconds"]);
        });

    autopoll
        .command("volatile <value>")
        .description("Set autopoll.volatile (true = one-shot per ping, false = persistent reminders)")
        .action(async (value: string) => {
            const v = value.toLowerCase();
            if (v !== "true" && v !== "false") {
                die(`volatile must be true or false, got '${value}'`);
            }
            await setAutopollField("volatile", v === "true");
        });

    autopoll
        .command("backlog <value>")
        .description(
            "Set autopoll.backlog (true = open-tickets count is also a notify trigger, not just context)",
        )
        .action(async (value: string) => {
            const v = value.toLowerCase();
            if (v !== "true" && v !== "false") {
                die(`backlog must be true or false, got '${value}'`);
            }
            await setAutopollField("backlog", v === "true");
        });
}
