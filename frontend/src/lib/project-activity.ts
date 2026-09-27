/**
 * Project activity split — the rule the sidebar and the mobile project picker
 * share (#537, #3132).
 *
 * A project is ACTIVE when a loop runs on it, or when something happened on it
 * within the last `ACTIVE_DAYS`. A waiting count (pending, unread, resolved)
 * no longer keeps a project up on its own: its tickets stay counted in "All
 * projects" and reachable in the fold.
 *
 * The active group is ordered by activity — running loops first, then the most
 * recent — so it reorders live as the board moves. It never shows fewer than
 * `MIN_ACTIVE`: on a quiet stretch the most recent projects fill it, rather than
 * an empty list. The inactive rest folds behind "More", by name, to be found
 * by name. The selected project always stays in view.
 */
export const ACTIVE_DAYS = 3;
export const MIN_ACTIVE = 5;

export interface ProjectActivitySignal {
    value: string | null;
    label: string;
    running?: boolean;
    last_activity?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** When it last moved, in ms; -Infinity when unknown (it sorts last). */
function lastMs(p: ProjectActivitySignal): number {
    const t = p.last_activity ? Date.parse(p.last_activity) : NaN;
    return Number.isNaN(t) ? -Infinity : t;
}

export function isProjectActive(p: ProjectActivitySignal, now = Date.now()): boolean {
    if (p.running) return true; // a loop runs on it: active, whatever its age
    return now - lastMs(p) < ACTIVE_DAYS * DAY_MS;
}

/** Running loops first, then the most recent activity. */
function byActivity(a: ProjectActivitySignal, b: ProjectActivitySignal): number {
    if (!!a.running !== !!b.running) return a.running ? -1 : 1;
    return lastMs(b) - lastMs(a);
}

/**
 * The projects (not the "All projects" row) as the pickers show them: the
 * active group ordered by activity, at least `MIN_ACTIVE` of them when there
 * are that many, the current project among them; the rest by name.
 */
export function splitProjects<T extends ProjectActivitySignal>(
    items: T[],
    current: string | null,
    now = Date.now(),
): { active: T[]; inactive: T[] } {
    const projects = items.filter((p) => p.value !== null).sort(byActivity);
    const active = projects.filter((p) => isProjectActive(p, now));
    for (const p of projects) {
        if (active.length >= MIN_ACTIVE) break;
        if (!active.includes(p)) active.push(p);
    }
    const cur = projects.find((p) => p.value === current);
    if (cur && !active.includes(cur)) active.push(cur);
    active.sort(byActivity);
    const inactive = projects.filter((p) => !active.includes(p)).sort((a, b) => a.label.localeCompare(b.label));
    return { active, inactive };
}
