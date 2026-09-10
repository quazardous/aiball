/**
 * Pane readiness, composed from the watchers: a prompt signature is visible AND
 * nothing that merely looks like a prompt is on screen. Pure, so the one
 * decision that lets a wake be typed is testable without the kernel.
 *
 * #2230 — `trustDialog` joined the transients: Claude Code's folder trust
 * dialog shows `❯ No, exit`, which the prompt watcher reads as a prompt, so
 * without it the pane was READY while the dialog waited for an answer.
 */
export interface PaneReadyInputs {
    promptVisible: boolean;
    pickerSession: boolean;
    pickerMode: boolean;
    resuming: boolean;
    compactConfirm: boolean;
    compacting: boolean;
    trustDialog: boolean;
}

export function composePaneReady(i: PaneReadyInputs): boolean {
    const pickerOrTransient = i.pickerSession || i.pickerMode || i.resuming
        || i.compactConfirm || i.compacting || i.trustDialog;
    return i.promptVisible && !pickerOrTransient;
}
