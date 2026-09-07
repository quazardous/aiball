/**
 * #2091 — the name a sub-agent gets when you don't feel like inventing one.
 *
 * `claude-loop init --sub-agent` is meant to be the short way to stand one up,
 * and being made to invent an identifier is most of what makes that long. So a
 * name is derived, and the derivation has to be PREDICTABLE: a human reading a
 * comment on a ticket should be able to say which machine wrote it without
 * looking anything up.
 *
 * Hence `<what it works on>-<where it runs>`: the project (or the directory,
 * when there is no project yet) and the host, resolved the same way a proxy
 * node resolves its own — Tailscale first, plain hostname otherwise. The second
 * half is the one that earns its place: a sub-agent exists precisely because
 * work is being spread across machines, so the machine is what distinguishes it
 * from its siblings.
 */

/** Keep what an identifier can carry, and nothing that would need quoting in a
 *  YAML value, a URL or a shell. Case is preserved: project names are chosen by
 *  people, and lowercasing them silently would rename them. */
function sanitize(part: string): string {
    return part
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "");
}

export interface SubAgentNameInput {
    /** `consumer.project`, or `--project`. The best answer when present. */
    project?: string | null;
    /** Fallback identity for the checkout: the directory's own name. */
    dirBase: string;
    /** This machine, as a paired node would report it. */
    host?: string | null;
}

/**
 * Derive a sub-agent id. Never empty: a name that fails to be derived would
 * leave the agent taking the global default and quietly sharing an identity
 * with another loop, which is the one outcome worth ruling out here.
 */
export function deriveSubAgentName(input: SubAgentNameInput): string {
    const what = sanitize(input.project ?? "") || sanitize(input.dirBase) || "aiball";
    const where = sanitize(input.host ?? "");
    // No host to speak of — say what it is rather than pretending to be
    // specific. Two of these on one machine is a case for passing a name.
    return where && where !== what ? `${what}-${where}` : `${what}-sub`;
}
