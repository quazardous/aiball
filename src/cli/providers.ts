/**
 * `aiball providers` command group (#354 v1). Manages remote-access
 * providers (tailscale today) declared in the GLOBAL config
 * `~/.config/aiball/config.yaml`. `up` is wired as the daemon unit's
 * ExecStartPost so providers come up with aiball.
 *
 * Exposed entry point: `registerProviderCommands(program)`.
 */
import type { Command } from "commander";
import { gOpts, out } from "./_helpers.js";

export function registerProviderCommands(program: Command): void {
    const providers = program
        .command("providers")
        .description(
            "Remote-access providers (tailscale, …). Config: `providers:` in ~/.config/aiball/config.yaml — see docs/CONFIGS.md (#354).",
        );

    providers
        .command("status")
        .description("Show configured providers + live tailscale serve status")
        // #2251 — the GNOME extension reads this to know whether a tailscale
        // provider is configured, without parsing the YAML itself.
        .option("--json", "Machine-readable JSON output")
        .action(async (opts: { json?: boolean }, cmd: Command) => {
            const { providersStatus } = await import("../providers.js");
            const s = providersStatus();
            out(s, { ...gOpts(cmd), json: opts.json === true || gOpts(cmd).json === true }, (v) => {
                if (!v.config.tailscale) {
                    return "No provider configured. Add a `providers:` block to ~/.config/aiball/config.yaml (see docs/CONFIGS.md).";
                }
                return [
                    "Configured providers:",
                    JSON.stringify(v.config, null, 2),
                    "",
                    "[tailscale serve status]",
                    v.tailscale ?? "(tailscale not reachable / not logged in)",
                ].join("\n");
            });
        });

    providers
        .command("up")
        .description("Bring up enabled+autostart providers (used by the daemon's ExecStartPost; also runnable manually)")
        .option("--all", "Bring up every enabled provider, not just autostart ones")
        .action(async (opts: { all?: boolean }) => {
            const { bringUpProviders } = await import("../providers.js");
            const res = bringUpProviders({ onlyAutostart: opts.all !== true });
            if (res.length === 0) {
                console.log("No autostart provider configured — nothing to do.");
                return;
            }
            for (const r of res) {
                console.log(`${r.provider}: ${r.ok ? "up ✓" : "FAILED"}${r.detail ? "\n  " + r.detail.replace(/\n/g, "\n  ") : ""}`);
            }
        });

    providers
        .command("down")
        .description("Take down configured providers (tailscale serve reset)")
        .action(async () => {
            const { bringDownProviders } = await import("../providers.js");
            const res = bringDownProviders();
            if (res.length === 0) {
                console.log("No provider configured — nothing to do.");
                return;
            }
            for (const r of res) console.log(`${r.provider}: ${r.ok ? "down ✓" : "FAILED"}${r.detail ? " — " + r.detail : ""}`);
        });
}
