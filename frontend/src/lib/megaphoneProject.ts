/**
 * #2613 — which project the megaphone (standing instruction + wake focus)
 * edits. The project filter wins; with no filter, an open ticket names its own
 * project, so "All projects" with a ticket open still shows that project's
 * instruction and focus. With neither, there is no project: the control says
 * to pick one.
 */
export function megaphoneProject(
    filterProject: string | null,
    openTicketId: number | null,
    openTicketProject: string | null,
): string | null {
    if (filterProject) return filterProject;
    return openTicketId !== null ? openTicketProject : null;
}
