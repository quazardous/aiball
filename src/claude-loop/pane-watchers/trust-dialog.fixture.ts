// #2230 — Claude Code's folder trust dialog, captured live from a loop started
// in a folder it had never trusted (80 columns). Shared by the watcher and the
// pane-readiness tests.
export const TRUST_DIALOG = [
    "────────────────────────────────────────────────────────────────────────────────",
    " Accessing workspace:",
    " /tmp/scratchpad/e2e2180",
    " Quick safety check: Is this a project you created or one you trust? (Like your",
    " own code, a well-known open source project, or work from your team). If not,",
    " take a moment to review what's in this folder first.",
    " Claude Code'll be able to read, edit, and execute files here.",
    " Security guide",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    " Enter to confirm · Esc to cancel",
].join("\n");
