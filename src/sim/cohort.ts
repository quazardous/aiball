/**
 * The simulated board's cast, read from a cohort YAML file (see tests/sim/cohort.yaml).
 * Pure: provisioning (inside the container) and the CLI (on the host) both read
 * the file through here, so they agree on who exists.
 */
import { parse } from "yaml";

export type SubscriptionRole = "owner" | "follower";

export interface CohortAgent {
    id: string;
    project: string;
    role: SubscriptionRole;
}

export interface Cohort {
    moderator: { id: string; password: string };
    projects: string[];
    agents: CohortAgent[];
}

const ID = /^[A-Za-z0-9._-]{1,64}$/;

export function parseCohort(text: string): Cohort {
    const raw = (parse(text) ?? {}) as {
        moderator?: { id?: unknown; password?: unknown };
        projects?: Record<string, { lead?: unknown } | null>;
        agents?: { id?: unknown; project?: unknown; role?: unknown }[];
    };
    const fail = (why: string): never => { throw new Error(`cohort: ${why}`); };
    const id = (v: unknown, what: string): string =>
        typeof v === "string" && ID.test(v) ? v : fail(`${what} must be an id (letters, digits, . _ -)`);

    const moderator = {
        id: id(raw.moderator?.id, "moderator.id"),
        password: typeof raw.moderator?.password === "string" && raw.moderator.password.length >= 6
            ? raw.moderator.password
            : fail("moderator.password must be at least 6 characters"),
    };
    const projects = Object.keys(raw.projects ?? {});
    if (projects.length === 0) fail("at least one project is required");
    projects.forEach((p) => id(p, "a project name"));

    const agents: CohortAgent[] = [];
    for (const p of projects) {
        const lead = raw.projects![p]?.lead;
        if (lead !== undefined) agents.push({ id: id(lead, `projects.${p}.lead`), project: p, role: "owner" });
    }
    for (const a of raw.agents ?? []) {
        const project = id(a.project, "agents[].project");
        if (!projects.includes(project)) fail(`agent ${String(a.id)} follows unknown project ${project}`);
        const role = a.role ?? "follower";
        if (role !== "owner" && role !== "follower") fail(`agents[].role must be owner or follower`);
        agents.push({ id: id(a.id, "agents[].id"), project, role: role as SubscriptionRole });
    }
    const seen = new Set<string>([moderator.id]);
    for (const a of agents) {
        if (seen.has(a.id)) fail(`${a.id} is declared twice`);
        seen.add(a.id);
    }
    return { moderator, projects, agents };
}
