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
import type { InboxRow, Intent, Strategy } from "./api";
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
export type SortBy = "activity" | "created_desc" | "created_asc";

export const STATUS_FILTER_OPTIONS: { label: string; value: StatusFilter }[] = [
    { label: "All", value: "all" },
    { label: "Unread", value: "unread" },
    { label: "Pending", value: "pending" },
    { label: "Approved", value: "approved" },
    { label: "Rejected", value: "rejected" },
];

export const SORT_OPTIONS: { label: string; value: SortBy }[] = [
    { label: "Recent activity", value: "activity" },
    { label: "Newest first", value: "created_desc" },
    { label: "Oldest first", value: "created_asc" },
];

// =====================================================================
//  Strategy options (moderation strategy in the header)
// =====================================================================

export const STRATEGY_OPTIONS: { label: string; value: Strategy; hint: string }[] = [
    {
        label: "Manual approve",
        value: "manual",
        hint: "Every message goes to human review.",
    },
    {
        label: "Auto approve",
        value: "auto",
        hint: "Everything is auto-approved (tickets and replies).",
    },
    {
        label: "Auto approve replies",
        value: "auto-reply",
        hint: "Replies auto-approved; new tickets need human review.",
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
