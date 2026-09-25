/**
 * #3017 — the tmux commands a loop's session gets for the mouse, as data so the
 * choice is testable without tmux.
 *
 * `mouse` on (the default): the scroll wheel scrolls the pane buffer instead of
 * reaching claude as Up/Down (#B.176), and a drag-select is piped to the system
 * clipboard (#B.181) — at the cost of the terminal's own selection and right-click
 * menu, which then need Shift. Off: the loop touches neither, so the terminal
 * keeps its native selection, right-click and Ctrl+Shift+C/V, and the wheel
 * no longer scrolls the pane.
 */

/** `true`/`false`, or the strings `on`/`off` (any case); anything else is unset. */
export function parseMouse(value: unknown): boolean | undefined {
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") return undefined;
    const v = value.trim().toLowerCase();
    return v === "on" ? true : v === "off" ? false : undefined;
}

/** The tmux argument lists to run, in order, for session `session`. */
export function mouseSetupCommands(session: string, mouse: boolean, clipboardCmd: string | null): string[][] {
    if (!mouse) return [];
    return [
        ["set-option", "-t", session, "mouse", "on"],
        // SSH/remote fallback path via OSC 52.
        ["set-option", "-t", session, "set-clipboard", "on"],
        // A real local clipboard tool when there is one (wl-copy / xclip / pbcopy):
        // robust across terminals, Ptyxis included (VTE blocks OSC 52 by default).
        // `-no-clear` keeps the selection on screen after the release.
        ["bind-key", "-T", "copy-mode", "MouseDragEnd1Pane", "send-keys", "-X", "copy-pipe-no-clear", ...(clipboardCmd ? [clipboardCmd] : [])],
    ];
}
