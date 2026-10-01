/** #3469 — a loop's bar for tests: idle, AFK, nothing to say, `over` on top. */
import type { AgentBar } from "../agent-bar.js";

export function sampleBar(over: Partial<AgentBar> = {}): AgentBar {
    return {
        phase: "idle",
        presence: "loop",
        afk: { mode: "off", expires_at: null },
        prompt: { visible: true, has_input: false },
        human_typing: false,
        marker: { info: null, health_prompt: false, resume_picker: false, resume_mode_picker: false },
        alerts: { link_down: false, daemon_down: false, not_logged_in: false, trust_dialog: false, api_unreachable: false, restart_needed: false, restart_pending: false, limit_reached: false },
        limit_resets: null,
        proxy_alive: true,
        zen: false,
        counters: null,
        next_wake_at: null,
        boot: null,
        host: "external",
        attach: { socket: null, reason: "no_socket" },
        ...over,
    };
}
