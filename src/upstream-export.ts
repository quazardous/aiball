/**
 * Upstream coupling phase 2 — Slice 1: manual export.
 *
 * `exportUpstream()` creates a NEW external issue from an existing aiball
 * ticket (title/body) and couples the ticket to it. It WRITES to the remote,
 * so callers gate it behind an explicit confirmation (UI button, CLI `--yes`);
 * the MCP tool call is itself the deliberate act.
 *
 * Manual only, like import — nothing here runs on a timer. A ticket already
 * coupled is refused (unlink first) so we never fork a second remote issue.
 */
import { loadConfig, upstreamToken, type TransportChoice } from "./autopoll/config.js";
import { resolveWire } from "./upstream-wire.js";
import { getMessage } from "./db.js";
import { setTicketUpstream } from "./db/upstream.js";
import { AlreadyCoupledError } from "./upstream-import.js";
import { providerByKind, type ExternalIssue, type UpstreamTarget } from "./upstream-providers.js";
import type { Message } from "./db/connection.js";

export interface ExportUpstreamInput {
    ticket_id: number;
    /** Provider id — defaults to "github". */
    kind?: string;
    /** Explicit `owner/repo` target; else the project's default binding is used. */
    repo?: string;
    by_agent?: string | null;
}

export interface ExportUpstreamResult {
    ticket: Message;
    external: ExternalIssue;
    provider: string;
}

export interface ExportUpstreamOpts {
    fetchImpl?: typeof fetch;
    token?: string | null;
}

export async function exportUpstream(
    input: ExportUpstreamInput,
    opts: ExportUpstreamOpts = {},
): Promise<ExportUpstreamResult> {
    const ticket = getMessage(input.ticket_id);
    if (!ticket || ticket.kind !== "ticket_created") {
        throw new Error(`ticket #${input.ticket_id} not found`);
    }
    if (ticket.upstream_kind) {
        // Already linked — refuse rather than create a second remote issue.
        throw new AlreadyCoupledError(ticket.id, ticket.upstream_ref ?? ticket.upstream_kind, ticket.upstream_num ?? 0);
    }

    const kind = input.kind ?? "github";
    const provider = providerByKind(kind);
    if (!provider?.createIssue) {
        throw new Error(`provider "${kind}" cannot export (no createIssue implemented)`);
    }

    // Resolve the target repo: explicit `owner/repo` wins, else the project's
    // default binding for this provider.
    let target: UpstreamTarget | null = null;
    // #1563 slice 3 — set when the target came from a binding, so its
    // `transport:` override applies. An explicit `--repo` matches no binding
    // and therefore rides the host-level choice.
    let bindingTransport: TransportChoice | undefined;
    if (input.repo) {
        target = provider.parseRef(`${provider.id}:${input.repo}`);
        if (!target) throw new Error(`invalid repo "${input.repo}" for provider "${kind}" (expected owner/repo)`);
    } else {
        const bindings = loadConfig().upstream[ticket.project] ?? [];
        const def = bindings.find((b) => b.kind === provider.id && b.default);
        if (!def) {
            throw new Error(
                `no default ${kind} binding for project "${ticket.project}" — add one to .aiball.yaml "upstream:" or pass an explicit repo`,
            );
        }
        target = provider.parseRef(def.ref);
        if (!target) throw new Error(`the default ${kind} binding for "${ticket.project}" is malformed: ${def.ref}`);
        bindingTransport = def.transport;
    }

    const token = opts.token ?? upstreamToken(provider.id);
    const { wire } = await resolveWire({
        choice: bindingTransport,
        kind: provider.id,
        token,
        fetchImpl: opts.fetchImpl,
    });
    const external = await provider.createIssue(
        target,
        { title: ticket.title ?? `aiball ticket #${ticket.id}`, body: ticket.body ?? "" },
        { token, fetchImpl: opts.fetchImpl, transport: wire },
    );

    const canonicalRef = `${provider.id}:${target.owner}/${target.repo}`;
    setTicketUpstream(ticket.id, { kind: provider.id, ref: canonicalRef, num: external.num });

    const coupled = getMessage(ticket.id) ?? ticket;
    return { ticket: coupled, external, provider: provider.id };
}
