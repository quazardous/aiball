/**
 * Upstream coupling (GitHub / GitLab), phase 2 — Slice 0: manual import.
 *
 * `importUpstream()` fetches a single external issue and creates a coupled
 * aiball ticket from it (title/body + labels→tags), recording the link in
 * the ticket's `upstream_*` columns. It is the shared core behind the three
 * surfaces (CLI / MCP / HTTP API).
 *
 * Manual only, by design: nothing here runs on a timer or auto-discovers
 * issues. A project's aiball-only tickets are never touched — coupling only
 * exists on tickets a human/agent explicitly imported. Ongoing state sync of
 * *already-coupled* tickets (incl. closing when the upstream issue closes) is
 * a later slice's background poller; import itself just seeds the ticket.
 */
import { loadConfig, upstreamToken } from "./autopoll/config.js";
import { submitMessage } from "./messages.js";
import { addMessageTag, getTagByName, insertTag } from "./db/tags.js";
import { findCoupledTicket, setTicketUpstream } from "./db/upstream.js";
import {
    providerByKind,
    resolveProjectRef,
    type ExternalIssue,
} from "./upstream-providers.js";
import type { Message } from "./db/connection.js";

export interface ImportUpstreamInput {
    /** aiball project the imported ticket lands in. */
    project: string;
    /** Textual ref: bare `gh#123` (needs a default binding) or explicit
     *  `gh:owner/repo#123` (self-contained). */
    ref: string;
    /** Consumer credited as the ticket author. */
    by_agent?: string | null;
}

export interface ImportUpstreamResult {
    ticket: Message;
    external: ExternalIssue;
    provider: string;
}

export interface ImportUpstreamOpts {
    /** Injectable fetch (tests). */
    fetchImpl?: typeof fetch;
    /** Explicit token override; defaults to the host-config / env token. */
    token?: string | null;
}

/**
 * Error thrown when the issue is already coupled to a ticket in this project.
 * Carries the existing ticket id so surfaces can point at it instead of
 * silently forking a duplicate.
 */
export class AlreadyCoupledError extends Error {
    constructor(public existingTicketId: number, ref: string, num: number) {
        super(`${ref}#${num} is already coupled to ticket #${existingTicketId}`);
        this.name = "AlreadyCoupledError";
    }
}

export async function importUpstream(
    input: ImportUpstreamInput,
    opts: ImportUpstreamOpts = {},
): Promise<ImportUpstreamResult> {
    const bindings = loadConfig().upstream[input.project] ?? [];
    const resolved = resolveProjectRef(input.ref, bindings);
    if (!resolved) {
        throw new Error(
            `can't resolve upstream ref "${input.ref}" for project "${input.project}" — ` +
            `use the explicit form (e.g. gh:owner/repo#123) or add a default binding ` +
            `to .aiball.yaml "upstream:"`,
        );
    }
    const provider = providerByKind(resolved.provider);
    if (!provider?.fetchIssue) {
        throw new Error(`provider "${resolved.provider}" cannot import (no fetchIssue implemented)`);
    }
    // Canonical ref for storage — normalized from the resolved target so the
    // bare and explicit forms of the same issue store identically (and the
    // idempotency check below actually matches).
    const canonicalRef = `${provider.id}:${resolved.target.owner}/${resolved.target.repo}`;

    const existing = findCoupledTicket(input.project, provider.id, canonicalRef, resolved.num);
    if (existing) throw new AlreadyCoupledError(existing.id, canonicalRef, resolved.num);

    const token = opts.token ?? upstreamToken(provider.id);
    const external = await provider.fetchIssue(resolved.target, resolved.num, {
        token,
        fetchImpl: opts.fetchImpl,
    });

    const ticket = submitMessage({
        project: input.project,
        kind: "ticket_created",
        title: external.title || `${provider.id}#${resolved.num}`,
        body: external.body,
        by_agent: input.by_agent ?? null,
        intent: "request",
    });

    setTicketUpstream(ticket.id, {
        kind: provider.id,
        ref: canonicalRef,
        num: resolved.num,
    });

    // Labels → tags. Prefer a project-scoped tag, fall back to a global one,
    // else create the tag project-scoped. Idempotent per (ticket, tag).
    for (const label of external.labels) {
        const tag = getTagByName(label, input.project)
            ?? getTagByName(label, null)
            ?? insertTag({ name: label, project: input.project });
        addMessageTag(ticket.id, tag.id, input.by_agent ?? null);
    }

    // Return a fresh row reflecting the coupling columns just written.
    const coupled = findCoupledTicket(input.project, provider.id, canonicalRef, resolved.num) ?? ticket;
    return { ticket: coupled, external, provider: provider.id };
}
