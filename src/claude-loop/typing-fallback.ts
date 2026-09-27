/**
 * #3165 — whether the loop guesses human typing from the pane (the pane-diff
 * fallback). Only when nothing better reports the keys: the PTY proxy feeds the
 * typing marker itself, and so does the session host (`host.keys`, from the
 * input it relays). Under either, a pane that changes is not typing: a resize
 * reflows it, an injected wake redraws it.
 */
export function paneDiffGuessesTyping(terminal: { hostControl: string | null; proxyAlive: () => boolean }): boolean {
    if (terminal.hostControl) return false;
    return !terminal.proxyAlive();
}
