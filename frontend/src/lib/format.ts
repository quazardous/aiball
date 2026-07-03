/**
 * Pure presentation formatters. No state, no side-effects.
 *
 * Extracted from InboxList.vue (#B.332 Phase D, per `#C.mf5h72`).
 */
import { type AutomationAction, type ConditionTree, type InboxRow, type TokenUsage } from "./api";

/**
 * #446 — token EFFORT: the genuinely NEW tokens a ticket consumed (input +
 * cache-writes + output). Excludes `cache_r` on purpose: cache reads are the
 * SAME conversation context re-read from cache on every turn (~the whole
 * prompt, e.g. ~240k each turn), so summing them across turns re-counts the
 * same context N times and inflates the tally — david's "cumule le cumul".
 * This is the headline figure shown in the UI. Returns 0 for a null tally.
 */
export function estTokenEffort(u: TokenUsage | null | undefined): number {
    if (!u) return 0;
    return (u.tokens_in ?? 0) + (u.cache_w ?? 0) + (u.tokens_out ?? 0);
}

/**
 * #404 — "cost-equivalent" token figure: effort PLUS the re-read context billed
 * at ~0.1× (cache reads are ~10× cheaper than fresh tokens). Kept for the
 * tooltips/cost view (#446 Hybrid): the cache-read component is real spend, but
 * it's shown SEPARATELY from the effort headline so the displayed number isn't
 * dominated by the same context re-read each turn. Returns 0 for a null tally.
 */
export function estTokenCost(u: TokenUsage | null | undefined): number {
    if (!u) return 0;
    return (u.tokens_in ?? 0) + (u.cache_w ?? 0) + (u.tokens_out ?? 0) + Math.round((u.cache_r ?? 0) * 0.1);
}

/**
 * #446 — shared tooltip for the token chip: the effort headline broken down,
 * then the re-read context shown apart with its ~0.1× cost-equivalent. Keeps
 * the four display sites (inbox row, thread header, projects, stats) consistent.
 */
export function tokenBreakdownTitle(u: TokenUsage | null | undefined): string {
    if (!u) return "";
    return `effort ${formatTokens(estTokenEffort(u))} tok — new tokens: in ${u.tokens_in} · out ${u.tokens_out} · cache-write ${u.cache_w}`
        + ` · context re-read (cache): ${formatTokens(u.cache_r)} — same context re-read each turn, billed ~0.1× → cost-equiv ~${formatTokens(estTokenCost(u))} tok`;
}

/** Compact token count: 1234 → "1.2k", 1_500_000 → "1.5M". */
export function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

/**
 * #457 slice 5.3a — render an automation rule's condition tree as a compact
 * one-liner for the rules-list view. Uses math-y combinators (∧/∨/¬) and
 * field-relation shorthand (`⊇` for `includes`, `∈` for `in`) so a 5-leaf
 * tree fits on one row instead of stacking chip badges.
 *
 * Examples :
 *   { kind: "and", children: [] }                                 → "(any)"
 *   { kind: "leaf", field: "project", op: "eq", value: "aiball" }→ "project=aiball"
 *   { kind: "or", children: [
 *       { kind: "and", children: [<project=aiball>, <tags⊇win>] },
 *       <intent=urgent>,
 *   ] }                                                          → "(project=aiball ∧ tags⊇win) ∨ intent=urgent"
 */
export function formatExpressionCompact(tree: ConditionTree): string {
    return renderNode(tree, 0);
}

function renderNode(node: ConditionTree, depth: number): string {
    switch (node.kind) {
        case "and": {
            if (node.children.length === 0) return "(any)";
            if (node.children.length === 1) return renderNode(node.children[0]!, depth);
            const inner = node.children.map((c) => renderNode(c, depth + 1)).join(" ∧ ");
            return depth > 0 ? `(${inner})` : inner;
        }
        case "or": {
            if (node.children.length === 0) return "(none)";
            if (node.children.length === 1) return renderNode(node.children[0]!, depth);
            const inner = node.children.map((c) => renderNode(c, depth + 1)).join(" ∨ ");
            return depth > 0 ? `(${inner})` : inner;
        }
        case "not":
            return `¬${renderNode(node.child, depth + 1)}`;
        case "leaf": {
            const v = formatLeafValue(node.value);
            switch (node.op) {
                case "eq":       return `${node.field}=${v}`;
                case "neq":      return `${node.field}≠${v}`;
                case "in":       return `${node.field}∈${v}`;
                case "includes": return `${node.field}⊇${v}`;
            }
        }
    }
}

function formatLeafValue(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map((x) => formatLeafValue(x)).join(",")}]`;
    if (v === null) return "null";
    if (typeof v === "string") return v;
    return JSON.stringify(v);
}

/** #457 slice 5.3a — render an action as a compact verb : "assign→agent",
 *  "auto-approve", "include in pickup", etc. Used in the rules-list label. */
export function formatActionCompact(a: AutomationAction): string {
    switch (a.kind) {
        case "assign":       return `assign→${a.consumer_id}`;
        case "decision":     return a.decision === "auto" ? "auto-approve" : "send to review";
        case "pickup":       return a.mode === "only" ? "include in pickup" : "exclude from pickup";
        case "add_tag":      return `add tag «${a.tag}»`;
        case "set_priority": return `priority=${a.priority}`;
        case "notify":       return `notify→${a.consumer_id}`;
    }
}

/**
 * Coarse relative time used in the inbox row. Buckets are picked for
 * scan-ability:
 *   < 1h    → "Nm ago"   (at least 1m, never 0m)
 *   < 1d    → "Nh ago"
 *   < 1w    → "Nd ago"
 *   older   → locale date string
 */
export function relativeTime(iso: string): string {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = 60_000, hr = 3_600_000, day = 86_400_000;
    if (diff < hr) return `${Math.max(1, Math.floor(diff / min))}m ago`;
    if (diff < day) return `${Math.floor(diff / hr)}h ago`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
    return d.toLocaleDateString();
}

/**
 * Seconds-granularity sibling of {@link relativeTime} (C2 slice 2 — absorbed
 * from ConsumersPanel) : takes an explicit `nowMs` so a reactive tick-clock
 * can drive repaint, tolerates null ("never") and unparsable input (echoed).
 */
export function relativeTimeFine(iso: string | null | undefined, nowMs: number = Date.now()): string {
    if (!iso) return "never";
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    const diff = nowMs - t;
    if (diff < 0) return "just now";
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * "last activity Ns/Nmin/Nh ago" liveness hint (C2 slice 2 — the byte-identical
 * `livenessTitle` pair in NodesPanel / NodeDetailPage).
 */
export function formatActivityAge(lastUsedAt: string | null, nowMs: number = Date.now()): string {
    if (!lastUsedAt) return "never seen";
    const ageSec = Math.max(0, Math.round((nowMs - Date.parse(lastUsedAt)) / 1000));
    if (ageSec < 60) return `last activity ${ageSec}s ago`;
    if (ageSec < 3600) return `last activity ${Math.round(ageSec / 60)}min ago`;
    return `last activity ${Math.round(ageSec / 3600)}h ago`;
}

/** Inline snippet of a row — agent-authored summary (#B.87) takes
 *  priority, otherwise fall back to the body's first ~140 chars.
 *  Both flattened (whitespace collapsed). */
export function snippetOf(r: InboxRow): string {
    const raw = r.summary && r.summary.trim().length > 0 ? r.summary : (r.body ?? "");
    const flat = raw.replace(/\s+/g, " ").trim();
    return flat.length > 140 ? flat.slice(0, 140) + "…" : flat;
}

/** Row title with a stable fallback so the layout doesn't jump. */
export function titleOf(r: InboxRow): string {
    return r.title ?? "(no title)";
}
