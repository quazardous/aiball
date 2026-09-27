/**
 * #3166 — `claude-loop` started where the agent's Claude already runs (in tmux,
 * or on the session host, from claude-loop or from tvty). Claude is never
 * started twice, nor restarted: this terminal joins it. As a copy by default
 * (it watches, types nothing, resizes nothing); `--force` takes the controls,
 * shared with the other clients as in tmux. Off a terminal, or with
 * `--no-attach`, there is nothing to join with: refused, saying where it runs.
 */
export type LivePlace = "tmux" | "host";

export type JoinVerdict =
    | { kind: "attach"; readonly: boolean; message: string }
    | { kind: "refuse"; message: string };

export function joinLiveLoop(opts: { force: boolean; attach: boolean; tty: boolean }, live: { name: string; place: LivePlace }): JoinVerdict {
    const where = live.place === "host" ? "on the daemon's session host" : "in tmux";
    if (!opts.attach || !opts.tty) {
        return {
            kind: "refuse",
            message: `loop '${live.name}' already runs ${where}. Attach with 'claude-loop attach ${live.name}' (add --read-only to watch), `
                + `or 'claude-loop rm ${live.name}' first to start fresh.`,
        };
    }
    if (opts.force) {
        return { kind: "attach", readonly: false, message: `loop '${live.name}' already runs ${where} — attaching with the controls (Ctrl-B D to detach)` };
    }
    return {
        kind: "attach",
        readonly: true,
        message: `loop '${live.name}' already runs ${where} — attaching as a copy, read-only (--force to take the controls; Ctrl-B D to detach${live.place === "host" ? ", or Ctrl-C" : ""})`,
    };
}
