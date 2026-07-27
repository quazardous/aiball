/**
 * Shared CLI helpers + humanizer formatters (carved out of cli.ts in
 * #B.213 phase 3.B on 2026-05-19). Every group module (auth, ticket,
 * rule, project, autopoll, …) imports the pieces it needs from here
 * rather than re-declaring them locally. cli.ts itself imports the
 * same module so behaviour stays identical.
 *
 * Pure / no global state — moving them is safe and reversible.
 */
import type { Command } from "commander";
import { AiballClient } from "../client.js";

export const URL = process.env.AIBALL_URL ?? "http://127.0.0.1:7777";

export interface GlobalOpts {
    human?: boolean;
    json?: boolean;
}

export function die(msg: string): never {
    process.stderr.write(`aiball: ${msg}\n`);
    process.exit(1);
}

/**
 * The invoker's working directory. The `bin/` entrypoint chdir's into the
 * install root before running us, which corrupts `process.cwd()`. It
 * preserves the original PWD in AIBALL_CWD so commands that walk
 * up from the project (autopoll, check, …) see the right tree.
 */
export function userCwd(): string {
    return process.env.AIBALL_CWD ?? process.cwd();
}

/** Print a value as JSON line; preserves the existing bash CLI contract. */
export function jsonline(value: unknown): void {
    process.stdout.write(JSON.stringify(value) + "\n");
}

/**
 * Resolve the aiball install root. The `bin/` entrypoint chdir's into
 * the install dir before running us, so process.cwd() AT STARTUP is
 * the install root — easier and faster than walking up looking for
 * package.json. Subcommands that need the user's invocation dir use
 * `userCwd()` (reads AIBALL_CWD which the entrypoint preserves).
 */
export function resolveInstallRoot(): string {
    return process.cwd();
}

/**
 * Output helper (#B.209). Human-readable text by default; JSON when the
 * global `--json` flag is set OR when no humanizer is registered for the
 * shape. Scripts that depended on the old JSON-default behaviour should
 * add `--json` to their `aiball …` invocations.
 */
export function out<T>(value: T, opts: GlobalOpts, humanFn?: (v: T) => string): void {
    if (opts.json === true || !humanFn) {
        process.stdout.write(JSON.stringify(value) + "\n");
        return;
    }
    const text = humanFn(value);
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

export function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------
// Humanizers (#B.209) — terse text formatters for non-JSON output.
// Every formatter accepts the same shape as the corresponding `--json`
// payload, so the JSON contract stays the source of truth.
// ---------------------------------------------------------------------

export function fmtWhoami(v: { consumer_id: string; cwd: string; source: string; human: boolean; default_project: string | null }): string {
    const lines = [
        `consumer: ${v.consumer_id}`,
        `project:  ${v.default_project ?? "(none)"}`,
        `source:   ${v.source}`,
        `cwd:      ${v.cwd}`,
    ];
    if (v.human) lines.push(`mode:     --human (acting as $AIBALL_HUMAN)`);
    return lines.join("\n");
}

export function fmtStatus(v: { daemon_up: boolean; url: string; paths: { home: string; db: string; db_size: number; spool_dir: string }; spool_pending: number; spool_failed?: number; proxy_node?: { upstream: string; strict: boolean } | null; providers?: { config: { tailscale?: { enabled: boolean; autostart: boolean; mode: string; port?: number } }; tailscale: string | null } }): string {
    const lines = [
        v.daemon_up ? `daemon: up at ${v.url}` : `daemon: DOWN (${v.url})`,
        `home:   ${v.paths.home}`,
        `db:     ${v.paths.db}${v.paths.db_size ? ` (${fmtBytes(v.paths.db_size)})` : " (missing)"}`,
        `spool:  ${v.spool_pending} pending (${v.paths.spool_dir})`,
    ];
    // #394: a proxy NODE relays to a remote aiball — no data lives here, so the
    // db line above is moot. Surface it right after `daemon:` so it's not missed
    // (distinct from the `proxy: tailscale` remote-ACCESS line below). On a proxy
    // node, `daemon: up` means the relay is up AND the remote is reachable.
    if (v.proxy_node) {
        const strict = v.proxy_node.strict ? "; strict" : "";
        lines.splice(1, 0, `mode:   PROXY NODE → ${v.proxy_node.upstream} (relaying; no local DB${strict})`);
    }
    // #389: only show the graveyard line when it's non-empty — a clean tree
    // shouldn't carry noise, but a backlog of rejected writes must be visible.
    if (v.spool_failed && v.spool_failed > 0) {
        lines.push(`        ⚠ ${v.spool_failed} failed (${v.paths.spool_dir}/failed) — rejected writes that never landed`);
    }
    // #380: remote-access providers — configured + live serve status. Only
    // shown when a provider is configured (no `providers:` block → no line).
    const ts = v.providers?.config.tailscale;
    if (ts) {
        const serve = v.providers?.tailscale ?? null;
        const urlLine = serve?.split("\n").find((l) => l.includes("://"))?.trim();
        const state = urlLine ? `up → ${urlLine}` : "down (not serving)";
        const flags = [ts.mode, ts.autostart ? "autostart" : "manual"].join(", ");
        lines.push(`proxy:  tailscale [${flags}] — ${state}`);
    }
    return lines.join("\n");
}

export function fmtSubscribe(v: { consumer_id: string; project: string; feed_path: string; subscription: unknown; monitor_command: string }): string {
    const warn = (v.subscription as { warning?: string } | null)?.warning;
    const lines = [
        warn ? `! ${warn}` : `subscribed ${v.consumer_id} → ${v.project}`,
        `feed:    ${v.feed_path}`,
        `monitor: ${v.monitor_command}`,
    ];
    return lines.join("\n");
}

export function fmtSubsList(v: unknown): string {
    const rows = Array.isArray(v) ? v : [];
    if (rows.length === 0) return "(no subscriptions)";
    return rows
        .map((r) => {
            const s = r as { project?: string; role?: string };
            return `- ${(s.project ?? "?").padEnd(24)} role=${s.role ?? "?"}`;
        })
        .join("\n");
}

export function fmtUnread(v: unknown): string {
    const rows = Array.isArray(v) ? v : [];
    if (rows.length === 0) return "(nothing new)";
    return rows.map((m) => fmtMessageRow(m as Record<string, unknown>)).join("\n");
}

export function fmtPostReceipt(v: unknown, kind: "ticket" | "comment" | "close"): string {
    const q = v as { queued?: boolean; file?: string };
    if (q.queued) return `spooled to ${q.file} (daemon offline — will replay on next drain)`;
    const m = v as { id?: number; ticket_id?: number; hashid?: string; project?: string; status?: string };
    const target = kind === "ticket"
        ? `ticket #${m.id ?? "?"}`
        : kind === "close"
            ? `ticket #${m.ticket_id ?? "?"} closed (event #${m.id ?? "?"})`
            : `comment #${m.hashid ?? m.id ?? "?"} on ticket #${m.ticket_id ?? "?"}`;
    const tail = m.status && m.status !== "approved" ? ` [status=${m.status}]` : "";
    return `posted ${target}${m.project ? ` in ${m.project}` : ""}${tail}`;
}

export function fmtTicketList(v: unknown): string {
    const raw = v as { result?: unknown[] } | unknown[];
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw.result) ? raw.result : [];
    if (rows.length === 0) return "(no tickets)";
    return rows
        .map((r) => {
            const t = r as {
                id?: number;
                title?: string;
                by_agent?: string;
                status?: string;
                closed?: boolean;
                tags?: unknown[];
                sub_ticket_count?: number;
            };
            const flag = t.closed
                ? "·"
                : t.status === "pending"
                    ? "?"
                    : t.status === "rejected"
                        ? "x"
                        : "✓";
            const title = (t.title ?? "(no title)").slice(0, 80);
            const tags = Array.isArray(t.tags) && t.tags.length ? ` [${t.tags.join(",")}]` : "";
            const sub = t.sub_ticket_count ? ` (+${t.sub_ticket_count} sub)` : "";
            return `${flag} #${String(t.id ?? "?").padStart(4)}  ${(t.by_agent ?? "?").padEnd(20)} ${title}${tags}${sub}`;
        })
        .join("\n");
}

export function fmtTicketThread(v: unknown): string {
    const x = v as {
        ticket?: Record<string, unknown>;
        comments?: unknown[];
        comment_count?: number;
    };
    const t = x.ticket as Record<string, unknown> | undefined;
    if (!t) return "(ticket not found)";
    const id = t.id;
    const title = t.title ?? "(no title)";
    const lines = [
        `#${id} — ${title}`,
        `by ${t.by_agent ?? "?"}  ${t.created_at ?? ""}  status=${t.status ?? "?"}${t.closed ? " (closed)" : ""}${t.resolved ? " (resolved)" : ""}`,
    ];
    if (Array.isArray(t.tags) && t.tags.length) lines.push(`tags: ${(t.tags as unknown[]).join(", ")}`);
    if (t.body) lines.push("", String(t.body));
    const comments = Array.isArray(x.comments) ? x.comments : [];
    if (comments.length === 0) {
        if (typeof x.comment_count === "number" && x.comment_count > 0) {
            lines.push("", `(${x.comment_count} comments — pass --json or re-fetch with full=true)`);
        }
    } else {
        lines.push("", `── ${comments.length} comment${comments.length === 1 ? "" : "s"} ──`);
        for (const c of comments) {
            const cc = c as Record<string, unknown>;
            const hash = cc.hashid ? `#${cc.hashid}` : `#${cc.id}`;
            lines.push("", `${hash}  ${cc.by_agent ?? "?"}  ${cc.created_at ?? ""}`);
            if (cc.body) lines.push(String(cc.body));
            else if (typeof cc.summary_until === "string") lines.push(`(summary_until) ${cc.summary_until}`);
        }
    }
    return lines.join("\n");
}

export function fmtMessageRow(m: Record<string, unknown>): string {
    const ts = (m.created_at as string | undefined) ?? "";
    const kind = (m.kind as string | undefined) ?? "?";
    const by = (m.by_agent as string | undefined) ?? "?";
    const tid = m.ticket_id ?? m.id;
    const title = m.title ?? m.body;
    const snippet = title ? String(title).split("\n")[0].slice(0, 80) : "";
    return `${ts}  ${kind.padEnd(14)} #${tid}  ${by.padEnd(20)} ${snippet}`;
}

export function fmtAutopollShow(v: { config_path: string | null; autopoll: Record<string, unknown>; consumer: Record<string, unknown> }): string {
    const lines = [
        `config: ${v.config_path ?? "(none found)"}`,
        `autopoll:`,
        ...Object.entries(v.autopoll).map(([k, val]) => `  ${k.padEnd(22)} = ${JSON.stringify(val)}`),
        `consumer:`,
        ...Object.entries(v.consumer).map(([k, val]) => `  ${k.padEnd(22)} = ${JSON.stringify(val)}`),
    ];
    return lines.join("\n");
}

export function fmtRuleList(v: unknown): string {
    const rows = Array.isArray(v) ? v : [];
    if (rows.length === 0) return "(no rules)";
    return rows
        .map((r) => {
            const x = r as {
                id?: number;
                decision?: string;
                enabled?: boolean | number;
                match_project?: string;
                match_kind?: string;
                match_by_agent?: string;
                note?: string;
            };
            const status = x.enabled ? "on " : "off";
            const filters = [
                x.match_project ? `project=${x.match_project}` : null,
                x.match_kind ? `kind=${x.match_kind}` : null,
                x.match_by_agent ? `by=${x.match_by_agent}` : null,
            ].filter(Boolean).join(" ");
            return `${status} #${String(x.id).padStart(3)} ${(x.decision ?? "?").padEnd(7)} ${filters || "(matches everything)"}${x.note ? ` — ${x.note}` : ""}`;
        })
        .join("\n");
}

export function fmtProjectList(v: unknown): string {
    const rows = Array.isArray(v) ? v : [];
    if (rows.length === 0) return "(no projects)";
    return rows
        .map((r) => {
            const p = r as { project?: string; name?: string; open_count?: number; total?: number };
            const name = p.project ?? p.name ?? "?";
            const counts = [
                typeof p.open_count === "number" ? `open=${p.open_count}` : null,
                typeof p.total === "number" ? `total=${p.total}` : null,
            ].filter(Boolean).join(" ");
            return `- ${name}${counts ? `  ${counts}` : ""}`;
        })
        .join("\n");
}

/** Resolve the active consumer id, honouring --human and AIBALL_AGENT. */
export function buildClient(globalOpts: { human?: boolean }): AiballClient {
    if (globalOpts.human) {
        const human = process.env.AIBALL_HUMAN ?? "human";
        return new AiballClient({ agentId: human });
    }
    return new AiballClient();
}

export function withProject(client: AiballClient, project: string | undefined): string {
    try {
        return client.resolveProject(project);
    } catch (e) {
        die((e as Error).message);
    }
}

export function gOpts(cmd: Command): GlobalOpts {
    // Walk up to root so subcommand contexts inherit --human.
    let p: Command | null = cmd;
    while (p && p.parent) p = p.parent;
    return (p?.opts() ?? {}) as GlobalOpts;
}
