import { sqliteTable, integer, text, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Drizzle schema for aiball. Matches the physical SQLite schema 1:1 — names,
 * types, FK targets all align with what's already in the DB so drizzle-kit
 * push/diff is a no-op against an existing populated database.
 *
 * Two physical tables hold messages:
 *   - tickets: thread roots (1 row per ticket; display_seq is per-project)
 *   - messages_table: comments + lifecycle events (FK→tickets; display_seq
 *     is per-ticket). Stored in the SQL table named `_messages` because the
 *     bare name `messages` was historically a view; the underscore reserves
 *     symmetry with future ALTER work without name clashes.
 *
 * Both share the global id pool via settings.next_global_id, so a single
 * INTEGER id uniquely identifies any row across both tables. That keeps
 * pings (which can reference either) on a clean single-FK-target shape —
 * we don't enforce the FK in SQL because it would have to point to two
 * tables, but app-level cleanup runs in deleteProject.
 */

export const tickets = sqliteTable("tickets", {
    id: integer("id").primaryKey(),
    project: text("project").notNull(),
    /** 1, 2, 3, ... per project. Stable across the project's lifetime. */
    displaySeq: integer("display_seq").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    byAgent: text("by_agent"),
    intent: text("intent"),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
    decidedBy: text("decided_by"),
    matchedRuleId: integer("matched_rule_id"),
    humanNote: text("human_note"),
    editedTitle: text("edited_title"),
    editedBody: text("edited_body"),
}, (t) => [
    uniqueIndex("idx_tickets_project_display").on(t.project, t.displaySeq),
    index("idx_tickets_project").on(t.project),
    index("idx_tickets_status").on(t.status),
]);

export const messages = sqliteTable("_messages", {
    id: integer("id").primaryKey(),
    ticketId: integer("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    /** 1, 2, 3, ... per ticket — per-thread numbering. */
    displaySeq: integer("display_seq").notNull(),
    /** comment_added | ticket_closed | ticket_reopened (no ticket_created here). */
    kind: text("kind").notNull(),
    parentMessageId: integer("parent_message_id"),
    body: text("body"),
    byAgent: text("by_agent"),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
    decidedBy: text("decided_by"),
    matchedRuleId: integer("matched_rule_id"),
    humanNote: text("human_note"),
    editedBody: text("edited_body"),
}, (t) => [
    uniqueIndex("idx_messages_ticket_display").on(t.ticketId, t.displaySeq),
    index("idx_messages_ticket").on(t.ticketId),
    index("idx_messages_kind").on(t.kind),
]);

export const rules = sqliteTable("rules", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    position: integer("position").notNull().default(0),
    matchProject: text("match_project"),
    matchKind: text("match_kind"),
    matchByAgent: text("match_by_agent"),
    decision: text("decision").notNull(),
    enabled: integer("enabled").notNull().default(1),
    note: text("note"),
    createdAt: text("created_at").notNull(),
}, (t) => [
    index("idx_rules_position").on(t.position),
]);

export const tags = sqliteTable("tags", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull().unique(),
    color: text("color"),
    position: integer("position").notNull().default(0),
    note: text("note"),
    createdAt: text("created_at").notNull(),
}, (t) => [
    index("idx_tags_position").on(t.position),
]);

export const ticketTags = sqliteTable("ticket_tags", {
    ticketId: integer("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    tagId: integer("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
    setAt: text("set_at").notNull(),
    setBy: text("set_by"),
}, (t) => [
    primaryKey({ columns: [t.ticketId, t.tagId] }),
    index("idx_ticket_tags_tag").on(t.tagId),
]);

export const subscriptions = sqliteTable("subscriptions", {
    consumerId: text("consumer_id").notNull(),
    project: text("project").notNull(),
    subscribedAt: text("subscribed_at").notNull(),
    /** Dormant since the cursor model was killed in 0.3.0; kept for data
     *  continuity but no longer read or written. */
    lastSeenId: integer("last_seen_id").notNull().default(0),
}, (t) => [
    primaryKey({ columns: [t.consumerId, t.project] }),
    index("idx_subscriptions_project").on(t.project),
]);

export const ticketSubscriptions = sqliteTable("ticket_subscriptions", {
    consumerId: text("consumer_id").notNull(),
    ticketId: integer("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    subscribedAt: text("subscribed_at").notNull(),
}, (t) => [
    primaryKey({ columns: [t.consumerId, t.ticketId] }),
    index("idx_ticket_subs_ticket").on(t.ticketId),
]);

/**
 * Per-recipient delivery rows. messageId may point at either tickets.id or
 * messages.id — both share the global id pool so the integer is unambiguous.
 * No FK constraint here (would have to span two tables); cleanup is enforced
 * in deleteProject.
 */
export const pings = sqliteTable("pings", {
    recipient: text("recipient").notNull(),
    messageId: integer("message_id").notNull(),
    createdAt: text("created_at").notNull(),
    seenAt: text("seen_at"),
}, (t) => [
    primaryKey({ columns: [t.recipient, t.messageId] }),
    index("idx_pings_recipient_unread").on(t.recipient),
]);

export const settings = sqliteTable("settings", {
    key: text("key").primaryKey(),
    value: text("value"),
});

// ---- inferred types ------------------------------------------------------

export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;

export type Rule = typeof rules.$inferSelect;
export type NewRuleRow = typeof rules.$inferInsert;

export type Tag = typeof tags.$inferSelect;
export type NewTagRow = typeof tags.$inferInsert;

export type Subscription = typeof subscriptions.$inferSelect;
export type TicketSubscription = typeof ticketSubscriptions.$inferSelect;
export type Ping = typeof pings.$inferSelect;
