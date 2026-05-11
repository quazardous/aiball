/**
 * Peek mode (per #B.79). When on, the UI suppresses any mark-read
 * side effect (auto-mark on thread view, manual toggleRead). The
 * endorsed agent's seen-state stays untouched — useful when
 * impersonating an agent for debugging.
 *
 * Controlled by the IdentityPicker via `localStorage.aiball.peek`.
 */

export function isPeek(): boolean {
    return localStorage.getItem("aiball.peek") === "1";
}
