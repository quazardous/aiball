/**
 * Project activity split (UI-audit C5.2) — the active/inactive rule that was
 * copied near-verbatim between Sidebar.vue and InboxToolbar.vue (#537 mirror).
 *
 * A project is ACTIVE iff a loop runs on it, or it has any signal (pending /
 * unread / resolved) with a recent-enough last ticket. Inactive projects fold
 * behind the "inactive" disclosure in both pickers.
 */
export const INACTIVE_AGE_DAYS = 14;

export interface ProjectActivitySignal {
    running?: boolean;
    pending?: number | null;
    unread?: number | null;
    resolved?: number | null;
    last_activity?: string | null;
}

export function isProjectActive(p: ProjectActivitySignal): boolean {
    if (p.running) return true; // loop running = actif sans question
    const hasSignal = (p.pending ?? 0) > 0 || (p.unread ?? 0) > 0 || (p.resolved ?? 0) > 0;
    if (!hasSignal) return false;
    // Recency check : si le dernier ticket est trop vieux, on dort.
    if (!p.last_activity) return true; // absent = back-compat, on assume fresh
    const ageMs = Date.now() - Date.parse(p.last_activity);
    if (Number.isNaN(ageMs)) return true; // ISO mal formé, on assume fresh
    return ageMs < INACTIVE_AGE_DAYS * 24 * 60 * 60 * 1000;
}
