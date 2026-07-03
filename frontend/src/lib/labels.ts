/**
 * UI string catalog — icons, tooltips, severities, option lists.
 *
 * Single source of truth for the literals that used to be scattered
 * across .vue files: lifecycle icons, bulk-action labels, header badge
 * tooltips, strategy option labels, etc.
 *
 * Created from #C.2gpcsd ("y a beaucoup de magic string aussi et des
 * label etc"). Phase E of #B.332.
 */
import type { InboxRow, Intent, Priority, Strategy } from "./api";
import type { BulkAction } from "./ticket-actions";
import type { LifecycleStage } from "./ticket-state";

// =====================================================================
//  Lifecycle stage → lead icon
// =====================================================================
//
// Drives the leading icon on each inbox row. Replaces the cascade of
// `<i v-if="r.status === 'rejected'" v-else-if="..."` in InboxList.

export interface StageIcon {
    icon: string;
    /** A CSS variable name (incl. the `--` prefix) used as `color:`. */
    color: string;
    /** Tooltip shown on hover. */
    title: string;
}

export const LIFECYCLE_ICONS: Record<LifecycleStage, StageIcon> = {
    rejected: {
        icon: "pi pi-times-circle",
        color: "--p-red-500",
        title: "rejected ticket",
    },
    "closed-resolved": {
        icon: "pi pi-check-circle",
        color: "--p-green-600",
        title: "closed (resolved)",
    },
    closed: {
        icon: "pi pi-lock",
        color: "--p-orange-500",
        title: "closed without explicit resolution (wontfix / abandoned / duplicate)",
    },
    resolved: {
        icon: "pi pi-check-circle",
        color: "--p-green-500",
        title: "resolved (proposal accepted, reporter has not closed yet)",
    },
    "pending-resolved": {
        // #967 david `8w5gr4` : vert (au lieu de l'ancien amber) pour
        // que pending-resolved soit visuellement distinct de pending-plan
        // dans la liste — plan reste amber `?` (« propose direction »),
        // resolution est vert ✓ (« propose done »), escalation rouge 🔔.
        // La nuance « pending vs final » est portée par le bord vert de
        // la row (`--attention-resolution`) + l'amber row tint quand
        // unread ; le glyph reste lisible « done-ish » au scan.
        icon: "pi pi-check-circle",
        color: "--p-green-500",
        title: "an agent proposed resolution — accept (close) or reject to bring it back",
    },
    "pending-escalation": {
        // #737 — modern formal escalation : the agent posted
        // `then:"escalate"` and the human action is still pending.
        // Red + bell so the eye catches it at the top of the inbox,
        // distinct from amber pending-resolution/plan (which are
        // softer "agent proposed, your call to validate").
        icon: "pi pi-bell",
        color: "--p-red-500",
        title: "ESCALATED — an agent flagged this for human action (admin / infra / policy); accept once you've done the thing or reject to de-escalate",
    },
    "pending-plan": {
        // #656 david: symmetric to pending-resolved but for plan
        // decisions (HOW choice awaiting reporter validation). Same
        // amber but a directions-flag glyph so the visual scan pairs
        // it with the rejected-plan family (which uses `pi-ban` for
        // "direction's a no"). Lightbulb / question-mark — `pi-question-circle`
        // reads as "a question on direction" without overloading the
        // resolve family.
        icon: "pi pi-question-circle",
        color: "--p-amber-500",
        title: "an agent proposed a plan — accept (greenlight) or reject to redirect",
    },
    "rejected-resolved": {
        // #B.168 follow-up: latest resolution was rejected, thread
        // still open. Red X mirrors the green check-circle of
        // resolved — same shape (times-circle) so the visual scan
        // pairs it with the resolution family.
        icon: "pi pi-times-circle",
        color: "--p-red-500",
        title: "you rejected the latest resolution — thread still open",
    },
    "rejected-plan": {
        // #B.173: latest plan decision was rejected. Visually
        // distinct from rejected-resolved (which is "work was
        // claimed done") — a rejected plan is "the proposed
        // direction didn't fly". Use the lightbulb-times pairing
        // (no exact PrimeIcons match → `pi-ban` reuses the blocked
        // family which already reads as "this direction's a no",
        // but in amber to differentiate from agent-escalation red).
        icon: "pi pi-ban",
        color: "--p-amber-500",
        title: "you rejected the latest plan — thread still open, awaiting new direction",
    },
    blocked: {
        // Agent escalation (#B.119): the ticket needs the human to
        // weigh in. Wording softened to "TBD" / to-be-discussed (#B.129
        // wording pass): the original "blocked" read as too hostile and
        // david wanted a more conversational frame. The underlying
        // mechanic stays the same — drops the ticket out of the
        // actionable backlog while it waits on the human — only the
        // label and tooltip change. `pi-ban` icon kept (it's the
        // encircled stop family, symmetric with `pi-check-circle`).
        icon: "pi pi-ban",
        color: "--p-red-500",
        title: "TBD — agent flagged this ticket for human discussion (reply, reopen, or close)",
    },
    snoozed: {
        icon: "pi pi-history",
        color: "--p-indigo-500",
        // Caller may augment with the actual deadline; this is the
        // fallback for rows without a known wake-up date.
        title: "snoozed",
    },
    open: {
        icon: "pi pi-ticket",
        color: "--p-text-muted-color",
        title: "open ticket",
    },
};

/**
 * Snooze rows want the actual wake-up date in the tooltip when
 * available; fall back to the catalog title otherwise.
 */
export function snoozedTooltip(postponed_until: string | null | undefined): string {
    if (!postponed_until) return LIFECYCLE_ICONS.snoozed.title;
    return `snoozed until ${new Date(postponed_until).toLocaleString()}`;
}

// =====================================================================
//  Severity tables (PrimeVue color tokens by enum value)
// =====================================================================

export type Severity = "success" | "info" | "warn" | "danger" | "secondary";

export const STATUS_SEVERITY: Record<InboxRow["status"], Severity> = {
    pending: "warn",
    approved: "success",
    rejected: "danger",
};

export const INTENT_SEVERITY: Record<Intent, Severity> = {
    panic: "danger",
    request: "info",
    question: "warn",
    fyi: "secondary",
    feature: "success", // #319: green — new feature work (branch + PR)
};

// #632 david `qjmg84` : the inlined Material Symbols SVG paths now live in
// `PriorityIcon.vue` (zero extra dep). PRIORITY_ICON kept removed — call
// sites use the component directly.

/**
 * #632 david `xsgcg6` : the priority chevron now lives next to the
 * checkbox (no Tag/decoration), so its color must be applied via
 * `style="color: var(...)"`. Bare CSS var name map
 * for icon-only rendering. `normal` has no color (caller skips render).
 * Uses PrimeVue's --p-* color tokens so dark/light theme follow.
 */
export const PRIORITY_COLOR_VAR: Record<Priority, string> = {
    urgent: "--p-red-500",
    high: "--p-orange-500",
    normal: "",
    low: "--p-blue-500",
};

// =====================================================================
//  Bulk action metadata
// =====================================================================
//
// One row per BulkAction. BulkBar renders a `v-for` over these instead
// of 8 inline `<Button>` blocks.

export interface BulkActionMeta {
    /** Displayed text on the button (count suffixed by the renderer). */
    label: string;
    icon: string;
    severity: Severity;
    /** Hover tooltip — should explain the silent-skip semantics. */
    tooltip: string;
    /** Rendering order — lower comes first (mark_read before close, etc.). */
    order: number;
    /** Some buttons render with `text` (low-emphasis) — defaults to false. */
    text?: boolean;
}

export const BULK_ACTION_META: Record<BulkAction, BulkActionMeta> = {
    mark_read: {
        label: "read",
        icon: "pi pi-envelope-open",
        severity: "secondary",
        tooltip: "Mark the selected unread tickets as read (others skipped)",
        order: 10,
        text: true,
    },
    mark_unread: {
        label: "unread",
        icon: "pi pi-envelope",
        severity: "secondary",
        tooltip: "Mark the selected read tickets as unread (others skipped)",
        order: 11,
        text: true,
    },
    snooze: {
        label: "snooze",
        icon: "pi pi-history",
        severity: "info",
        tooltip: "Snooze the selected open tickets for 3 days (others skipped). Use the thread toolbar for a custom duration.",
        order: 20,
        text: true,
    },
    unsnooze: {
        label: "unsnooze",
        icon: "pi pi-bell",
        severity: "info",
        tooltip: "Bring the selected snoozed tickets back to the open inbox now.",
        order: 21,
        text: true,
    },
    close: {
        label: "close",
        icon: "pi pi-lock",
        severity: "warn",
        tooltip: "Close the selected open tickets (others skipped). Only the reporter / human can close.",
        order: 30,
        text: true,
    },
    reopen: {
        label: "reopen",
        icon: "pi pi-unlock",
        severity: "info",
        tooltip: "Reopen the selected closed tickets (others skipped).",
        order: 31,
        text: true,
    },
    approve: {
        label: "approve",
        icon: "pi pi-check",
        severity: "success",
        tooltip: "Approve the selected pending tickets (others skipped).",
        order: 40,
    },
    reject: {
        label: "reject",
        icon: "pi pi-times",
        severity: "danger",
        tooltip: "Reject the selected pending tickets (others skipped).",
        order: 41,
    },
    link: {
        label: "link",
        icon: "pi pi-link",
        severity: "info",
        tooltip: "Link the selected tickets — the most recent gets `relates_to` edges to each of the others (star pattern). Rejected rows skipped.",
        order: 25,
        text: true,
    },
};

/** Iterate the catalog in render order. mark_read/mark_unread are paired
 *  (the bar collapses them into one button picking the larger count). */
export const BULK_ACTIONS_IN_ORDER: BulkAction[] = (
    Object.entries(BULK_ACTION_META) as [BulkAction, BulkActionMeta][]
)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([k]) => k);

// =====================================================================
//  Inbox filter + sort options
// =====================================================================
//
// Moved out of App.vue inline definitions. Same shape, same labels.

export type StatusFilter = "all" | "unread" | "pending" | "approved" | "rejected";
export type SortBy = "activity" | "priority" | "created_desc" | "created_asc";

export const STATUS_FILTER_OPTIONS: { label: string; value: StatusFilter }[] = [
    { label: "All", value: "all" },
    { label: "Unread", value: "unread" },
    { label: "Pending", value: "pending" },
    { label: "Approved", value: "approved" },
    { label: "Rejected", value: "rejected" },
];

export const SORT_OPTIONS: { label: string; value: SortBy }[] = [
    { label: "Recent activity", value: "activity" },
    // #B.222 sxrz48 david: priority sort in the inbox. urgent → high
    // → normal → low; ties broken by created_desc so a single bucket
    // still surfaces the newest first.
    { label: "Priority", value: "priority" },
    { label: "Newest first", value: "created_desc" },
    { label: "Oldest first", value: "created_asc" },
];

// =====================================================================
//  Strategy options (moderation strategy in the header)
// =====================================================================

export const STRATEGY_OPTIONS: { label: string; value: Strategy; hint: string; icon: string }[] = [
    {
        label: "Manual approve",
        value: "manual",
        hint: "Every message goes to human review.",
        icon: "pi pi-shield",
    },
    {
        label: "Auto approve",
        value: "auto",
        hint: "Everything is auto-approved (tickets and replies).",
        icon: "pi pi-bolt",
    },
    {
        label: "Auto approve replies",
        value: "auto-reply",
        hint: "Replies auto-approved; new tickets need human review.",
        icon: "pi pi-reply",
    },
];

// =====================================================================
//  Header badge tooltips
// =====================================================================
//
// Pluralization-aware helpers used by HeaderBar.vue. Kept as functions
// since the count is the variable part.

function plural(n: number): string {
    return n > 1 ? "s" : "";
}

export const HEADER_BADGE_TOOLTIPS = {
    pending(n: number): string {
        return `${n} pending moderation across all projects`;
    },
    unread(n: number): string {
        return `${n} unread for you across all projects`;
    },
    resolved(n: number): string {
        return `${n} resolution proposal${plural(n)} waiting for your accept/reject`;
    },
    snoozed(n: number, shown: boolean): string {
        if (shown) {
            return `Showing snoozed tickets in the open inbox (${n}). Click to hide them.`;
        }
        if (n > 0) {
            return `${n} ticket${plural(n)} currently snoozed (hidden). Click to surface them in the open inbox.`;
        }
        return "No tickets currently snoozed. Click to surface any future snooze in the open inbox.";
    },
} as const;
