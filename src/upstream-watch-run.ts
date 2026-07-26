/**
 * #1566 — the periodic half of the link watch.
 *
 * Pure decisions live in `upstream-watch.ts`; this file is the part that
 * touches the network and the DB. It runs as the `upstream-watch` entry of the
 * cron table (#1566 step 1), so it inherits the catch, the overlap guard and
 * the `/api/health` record without re-implementing any of them — and the `gh`
 * timeout (#1563) means one wedged subprocess can no longer freeze the sweep.
 *
 * What it does per coupled ticket: one request, compare the remote
 * `updated_at` to the stored watermark, and — only when it moved — post ONE
 * notice in the thread as `__system:upstream`. No ticket field is ever
 * overwritten. A tick where nothing changed writes a timestamp and nothing else.
 */
import { loadConfig, upstreamToken, upstreamSyncMode } from "./autopoll/config.js";
import { listCoupledTickets, recordUpstreamProbe } from "./db/upstream.js";
import { upsertConsumer } from "./db/consumers.js";
import { submitMessage } from "./messages.js";
import { providerByKind } from "./upstream-providers.js";
import { resolveWire } from "./upstream-wire.js";
import { decideWatch, formatUpstreamNotice, UPSTREAM_ACTOR } from "./upstream-watch.js";

/** Bound the sweep: the wire spawns a process per call on the `gh` transport. */
const MAX_IN_FLIGHT = 4;

let actorReady = false;

/**
 * The identity exists as a real consumer row so the UI renders a name rather
 * than a blank author, and so anything querying by `kind` can exclude machine
 * voices properly. Created on first use — no boot seeding, no migration.
 */
function ensureUpstreamActor(): void {
    if (actorReady) return;
    upsertConsumer({
        consumer_id: UPSTREAM_ACTOR,
        kind: "system",
        display_name: "upstream",
        note: "Automatic voice of the upstream link watcher (#1566). Not an agent: holds no token and takes no assignment.",
    });
    actorReady = true;
}

export interface WatchSweepResult {
    checked: number;
    announced: number;
    failed: number;
    skipped: number;
}

/**
 * One sweep over every coupled ticket. Never throws: a single broken link must
 * not stop the others, so failures are recorded per ticket and counted.
 */
export async function runUpstreamWatch(): Promise<WatchSweepResult> {
    const out: WatchSweepResult = { checked: 0, announced: 0, failed: 0, skipped: 0 };
    const coupled = listCoupledTickets();
    if (coupled.length === 0) return out;

    const queue = [...coupled];
    const workers = Array.from({ length: Math.min(MAX_IN_FLIGHT, queue.length) }, async () => {
        for (;;) {
            const t = queue.shift();
            if (!t) return;
            // Per-project opt-out, layered like the transport choice: a project
            // can be coupled for rendering and imports without being watched.
            if (upstreamSyncMode(t.project) === "off") { out.skipped++; continue; }
            const provider = providerByKind(t.kind);
            if (!provider?.fetchIssue) { out.skipped++; continue; }
            const target = provider.parseRef(t.ref || defaultRefFor(t.project, t.kind));
            if (!target) {
                // A coupling whose binding vanished from the config: report it
                // instead of failing silently — that IS the visible breakage.
                recordUpstreamProbe(t.id, {
                    ok: false,
                    error: `no ${t.kind} binding resolves this coupling (project "${t.project}")`,
                });
                out.failed++;
                continue;
            }
            out.checked++;
            try {
                const token = upstreamToken(provider.id);
                const { wire } = await resolveWire({ kind: provider.id, token, quiet: true });
                const external = await provider.fetchIssue(target, t.num, { token, transport: wire });
                const decision = decideWatch({ seenAt: t.seenAt }, external);
                if (decision.kind === "unchanged") {
                    recordUpstreamProbe(t.id, { ok: true });
                    continue;
                }
                if (decision.kind === "adopt") {
                    // First observation: arm the watermark, stay quiet.
                    recordUpstreamProbe(t.id, { ok: true, seenAt: decision.seenAt });
                    continue;
                }
                ensureUpstreamActor();
                const ref = `${provider.refPrefix}#${t.num}`;
                submitMessage({
                    project: t.project,
                    kind: "comment_added",
                    ticket_id: t.id,
                    body: formatUpstreamNotice(ref, external),
                    by_agent: UPSTREAM_ACTOR,
                });
                // Only after the notice landed — if the post throws, the
                // watermark stays put and the next sweep retries rather than
                // swallowing the change.
                recordUpstreamProbe(t.id, { ok: true, seenAt: decision.seenAt });
                out.announced++;
            } catch (e) {
                recordUpstreamProbe(t.id, { ok: false, error: (e as Error).message });
                out.failed++;
            }
        }
    });
    await Promise.all(workers);
    return out;
}

/** The project's default binding ref, for couplings that store none (the
 *  common case per the storage rule — config is authoritative). */
function defaultRefFor(project: string, kind: string): string {
    const bindings = loadConfig().upstream[project] ?? [];
    return bindings.find((b) => b.kind === kind && b.default)?.ref ?? "";
}
