/**
 * `aiball providers` command group (#354 v1). Manages remote-access
 * providers (tailscale today) declared in the GLOBAL config
 * `~/.config/aiball/config.yaml`. `up` is wired as the daemon unit's
 * ExecStartPost so providers come up with aiball.
 *
 * Exposed entry point: `registerProviderCommands(program)`.
 */
import type { Command } from "commander";

export function registerProviderCommands(program: Command): void {
    const providers = program
        .command("providers")
        .description(
            "Remote-access providers (tailscale, …). Config: `providers:` in ~/.config/aiball/config.yaml — see docs/CONFIGS.md (#354).",
        );

    providers
        .command("status")
        .description("Show configured providers + live tailscale serve status")
        .action(async () => {
            const { providersStatus } = await import("../providers.js");
            const s = providersStatus();
            if (!s.config.tailscale) {
                console.log("No provider configured. Add a `providers:` block to ~/.config/aiball/config.yaml (see docs/CONFIGS.md).");
                return;
            }
            console.log("Configured providers:");
            console.log(JSON.stringify(s.config, null, 2));
            console.log("\n[tailscale serve status]");
            console.log(s.tailscale ?? "(tailscale not reachable / not logged in)");
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
