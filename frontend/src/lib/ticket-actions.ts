/**
 * Per-action applicability predicates. These tell the UI whether a
 * bulk button should be enabled, or whether a row should be skipped in
 * a multi-row operation (#B.327 — silent skip rather than refusing the
 * whole batch).
 *
 * They mirror what the server will accept, but live here so the UI can
 * pre-disable buttons without a round-trip. The daemon is still the
 * authoritative gate (owner-bypass, rule engine, …).
 *
 * Extracted from App.vue's bulkApplicable switch (#B.332 Phase D, per `#C.mf5h72`).
 */
import { type InboxRow } from "./api";
import { isClosed, isOpen, isPending, isSnoozed, isUnread } from "./ticket-state";

export type BulkAction =
    | "approve"
    | "reject"
    | "close"
    | "reopen"
    | "mark_read"
    | "mark_unread"
    | "snooze"
    | "unsnooze";

export function canApprove(r: InboxRow): boolean {
    return isPending(r);
}

export function canReject(r: InboxRow): boolean {
    return isPending(r);
}

export function canClose(r: InboxRow): boolean {
    return isOpen(r);
}

export function canReopen(r: InboxRow): boolean {
    return isClosed(r);
}

export function canSnooze(r: InboxRow): boolean {
    return isOpen(r);
}

export function canUnsnooze(r: InboxRow): boolean {
    return isSnoozed(r);
}

export function canMarkRead(r: InboxRow): boolean {
    return isUnread(r);
}

export function canMarkUnread(r: InboxRow): boolean {
    return !isUnread(r);
}

/**
 * Dispatch table — single entry point used by `bulkApplicable` so the
 * caller can ask "can I do X on this row?" without a switch.
 */
export const BULK_PREDICATES: Record<BulkAction, (r: InboxRow) => boolean> = {
    approve: canApprove,
    reject: canReject,
    close: canClose,
    reopen: canReopen,
    mark_read: canMarkRead,
    mark_unread: canMarkUnread,
    snooze: canSnooze,
    unsnooze: canUnsnooze,
};

export function canDo(action: BulkAction, r: InboxRow): boolean {
    return BULK_PREDICATES[action](r);
}
