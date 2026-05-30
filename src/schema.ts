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

/**
 * #B.216 phase A pass 1: explicit project registry.
 *
 * Until pass 1 a "project" existed implicitly — the set of distinct
 * values of `tickets.project`. The new `projects` table is the first
 * place where a project can be declared BEFORE any ticket is filed,
 * which is what the CLI `aiball project init` and the Web UI's
 * "Create project" button need.
 *
 * Soft registry by design: `tickets.project` stays a free TEXT column
 * (no SQL FK), so legacy tickets keep working and an orphan ticket on
 * an unregistered project still inserts. Listings + the new POST
 * endpoint (pass 2) read from this table; the implicit-project path
 * stays available as a fallback.
 */
export const projects = sqliteTable("projects", {
    /** Immutable lookup key — must match `tickets.project`. */
    name: text("name").primaryKey(),
    /** Optional human-friendly label for the UI ("Aiball BAL"). */
    displayName: text("display_name"),
    description: text("description"),
    createdAt: text("created_at").notNull(),
    /** consumer_id that registered the project (NULL for backfilled rows when no author was on file). */
    createdBy: text("created_by"),
    /**
     * Per-project response-strategy override (#B.224). NULL = inherit
     * the global default. Stored as a typed column rather than a k/v
     * settings row (the previous `strategy:<project>` hack); future
     * per-project preferences (default_intent, default_priority, etc.)
     * add their own columns and surface through the same
     * `src/preferences.ts` SDK.
     */
    defaultStrategy: text("default_strategy"),
});

export const tickets = sqliteTable("tickets", {
    id: integer("id").primaryKey(),
    project: text("project").notNull(),
    /** 1, 2, 3, ... per project. Stable across the project's lifetime. */
    displaySeq: integer("display_seq").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    /**
     * Optional agent-authored single-line summary (#B.87). Distinct from
     * `title` (short, often tag-like) and `body` (long markdown). Shown
     * in inbox lists, ping notifications, search snippets. Falls back to
     * `title` when null.
     */
    summary: text("summary"),
    byAgent: text("by_agent"),
    intent: text("intent"),
    /**
     * Urgency hint orthogonal to `intent` (#B.222). Enum gated at the
     * SQL layer via CHECK constraint (low / normal / high / urgent).
     * Backfilled to 'normal' for pre-existing rows. Used by listMessages
     * ticket sort + listPings secondary parent-priority sort + poll
     * my_pending_tickets sort.
     */
    priority: text("priority").notNull().default("normal"),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
    decidedBy: text("decided_by"),
    matchedRuleId: integer("matched_rule_id"),
    humanNote: text("human_note"),
    editedTitle: text("edited_title"),
    editedBody: text("edited_body"),
    /**
     * Event scope (#B.245 tristate, replaces the legacy `broadcast`
     * boolean). One of `internal` / `default` / `broadcast` — see
     * `_messages.scope` for the same enum and its fan-out semantics.
     * On a ticket, this scopes the ticket_created event itself; each
     * comment in the thread carries its own `scope` independently.
     *
     * Flipping this is NOT retroactive — followers only start getting
     * pings on the *next* activity at `broadcast` scope.
     */
    scope: text("scope").notNull().default("default"),
    /**
     * Snooze / postpone (per #B.329). When set to an ISO8601 timestamp in
     * the future, the ticket is hidden from the open-inbox view (treated
     * as closed). At that timestamp, the daemon's reveal cron clears the
     * field and posts a synthetic `ticket_reopened` so the ticket bounces
     * back into the inbox with the usual ping fan-out. While snoozed, no
     * pings fire (the user explicitly put it aside).
     */
    postponedUntil: text("postponed_until"),
    /**
     * Optional parent ticket — when set, this ticket is a sub-ticket of
     * `parentTicketId`. Used to split a large request into actionable
     * children while keeping the lineage explicit (per #B.61 follow-up).
     *
     * ON DELETE SET NULL: deleting the parent leaves children as
     * top-level rather than cascading (kids may still be relevant).
     */
    parentTicketId: integer("parent_ticket_id").references((): any => tickets.id, { onDelete: "set null" }),
    /**
     * Sidecar JSON metadata (#B.104). Today: question-answer audit
     * (`{"questions": {"q-abc": {"answered_by", "answered_at",
     * "answered_in"}}}`). Future fields colocate here — sidecar
     * pattern, no new table for every new metadata kind.
     */
    meta: text("meta"),
    /**
     * #374: denormalized "last actor" — the consumer who took the LAST
     * action on this ticket (post a comment, accept/reject a decision,
     * close / reopen / resolve / block). Drives the per-consumer
     * `actionable` gate (actionable iff `lastActor != me` OR sole
     * participant). Maintained by `bumpLastActor` at every action
     * chokepoint; backfilled idempotently at boot. NULL only on rows that
     * never saw a non-auto actor. See docs/TICKET_LIFECYCLE.md.
     */
    lastActor: text("last_actor"),
    lastActorAt: text("last_actor_at"),
    /**
     * #418/#436: two ORTHOGONAL axes (split in #436 — they were fused in #418).
     *
     * ASSIGNMENT — `assignee` / `assignedBy` / `assignedAt`: a RESPONSIBILITY a
     * human moderator *pushes* onto a consumer ("this is yours to do"). Persistent
     * — it does NOT auto-expire; cleared on reassign/close. Boosts the assignee's
     * claimable work-order (#436 decision 4).
     *
     * CLAIM — `claimant` / `claimedAt`: the FOCUS an agent *self-declares* ("I'm on
     * this now"), via ticket_engage / a self ticket_assign. TRANSIENT: the live
     * window is DERIVED (`now − claimedAt < assign_window_sec`, same pattern as
     * hot) and one-focus (engage releases the prior uncommented claim). Drives the
     * work-order tiebreak (#430) + token attribution (#434).
     *
     * A ticket can be BOTH assigned to A and claimed by A at once. A live claim OR
     * a live assignment to someone ELSE drops the ticket from a consumer's
     * actionable pool (anti-collision); see src/db/assignment-gate.ts. `isClaim`
     * is vestigial post-#436 (kept to avoid a table rebuild; new code uses
     * `claimant`).
     */
    assignee: text("assignee"),
    assignedBy: text("assigned_by"),
    assignedAt: text("assigned_at"),
    isClaim: integer("is_claim").notNull().default(0),
    claimant: text("claimant"),
    claimedAt: text("claimed_at"),
}, (t) => [
    uniqueIndex("idx_tickets_project_display").on(t.project, t.displaySeq),
    index("idx_tickets_project").on(t.project),
    index("idx_tickets_status").on(t.status),
    index("idx_tickets_postponed").on(t.postponedUntil),
    index("idx_tickets_parent").on(t.parentTicketId),
    index("idx_tickets_priority").on(t.priority),
    index("idx_tickets_assignee").on(t.assignee),
    index("idx_tickets_claimant").on(t.claimant),
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
    /**
     * Public-facing comment reference (#C<hashid>). 6-char base32 string,
     * randomly generated at insert time. Distinct from the internal numeric
     * id so users never confuse a comment ref with a ticket number. NULL on
     * legacy rows until the bootstrap backfill runs (then enforced unique
     * by app-level checks at insert).
     */
    hashid: text("hashid"),
    /**
     * For `ticket_sub_added` and `ticket_referenced` pseudo-comments,
     * points at the source ticket that triggered the relation. NULL on
     * regular comments and other lifecycle events. ON DELETE CASCADE
     * with the source so deleting the source also wipes its pseudo
     * notifications elsewhere.
     */
    sourceTicketId: integer("source_ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    /** Sidecar JSON metadata (#B.104). Same shape as `tickets.meta`. */
    meta: text("meta"),
    /**
     * Event scope (#B.245 tristate). One of:
     *   `internal`  — owners only + @mentions explicites; @projet
     *                 narrows to project owners (not followers).
     *   `default`   — ticket subscribers + project owners + @mentions
     *                 (the standard fan-out).
     *   `broadcast` — `default` + project followers.
     *
     * Composer remembers the last value chosen per-ticket (#79h7zk).
     * Replies default to `internal` (existing threads have their
     * audience, broad fan-out on every reply over-notifies). New
     * tickets default to `default`.
     */
    scope: text("scope").notNull().default("default"),
}, (t) => [
    uniqueIndex("idx_messages_ticket_display").on(t.ticketId, t.displaySeq),
    index("idx_messages_ticket").on(t.ticketId),
    index("idx_messages_kind").on(t.kind),
    index("idx_messages_hashid").on(t.hashid),
    index("idx_messages_source").on(t.sourceTicketId),
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

// #447: per-agent work filters — narrow which tickets a consumer (agent) picks
// up, by tag. Stored here in the daemon DB (not per-machine config) so every
// loop hitting this daemon shares the same filter. Applied in the actionable/
// claimable gate. Mirrors the `rules` table's shape (position + enabled mute).
export const workFilters = sqliteTable("work_filters", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The agent (consumer_id) this filter constrains. */
    consumerId: text("consumer_id").notNull(),
    /** Optional project scope. NULL = applies across all the consumer's projects. */
    project: text("project"),
    /** 'only' = work ONLY matching tickets; 'except' = never work matching ones. */
    mode: text("mode").notNull().default("only"),
    /** JSON array of tag names (any-of): a ticket matches if it carries ≥1. */
    matchTags: text("match_tags").notNull().default("[]"),
    enabled: integer("enabled").notNull().default(1),
    position: integer("position").notNull().default(0),
    note: text("note"),
    createdAt: text("created_at").notNull(),
}, (t) => [
    index("idx_work_filters_consumer").on(t.consumerId),
]);

// #457 — unified automation engine (event-driven rule engine). Single table
// for ALL automation rules : the legacy `rules` (moderation) + `work_filters`
// (pickup gate) migrate into this in slice 3, AND new triggers
// (ticket_created, ticket_tagged) + new actions (assign_to) plug in without
// any further schema change (action_kind + JSON action_data carry the
// discriminator). See `src/db/automation.ts` for the typed Rule shape and
// `src/automation/engine.ts` for the pure matcher.
export const automationRules = sqliteTable("automation_rules", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** JSON array of lifecycle events this rule fires for (david `8r7crj` :
     *  a rule can union multiple triggers — e.g. `["ticket_created",
     *  "ticket_tagged"]` for "assign win-tag tickets at creation OR when
     *  the tag is added later", instead of duplicating into 2 rules). */
    triggers: text("triggers").notNull().default("[]"),
    /** NULL = global rule. Otherwise the consumer_id this rule applies to
     *  (work-filter case — narrows the pickup gate for that agent only). */
    scopeConsumer: text("scope_consumer"),
    /** Condition vocabulary — all optional (NULL = "any"). Each maps to a
     *  ticket/event attribute the engine checks at fire time. */
    matchProject: text("match_project"),
    matchKind: text("match_kind"),
    matchByAgent: text("match_by_agent"),
    /** JSON array of tag names, any-of match (a ticket "matches" when it
     *  carries ≥1 listed tag). Same semantics as the legacy work_filters
     *  `match_tags`. */
    matchTags: text("match_tags").notNull().default("[]"),
    /** ticket_tagged trigger only — fires only when THIS specific tag was
     *  the one just added (not just present). NULL = any tag addition. */
    matchTagAdded: text("match_tag_added"),
    matchIntent: text("match_intent"),
    matchPriority: text("match_priority"),
    /** Discriminator : decision / pickup / assign / add_tag / set_priority /
     *  notify. New actions = new value, no schema change. */
    actionKind: text("action_kind").notNull(),
    /** JSON payload, typed by action_kind. e.g. for `assign` :
     *  `{"consumer_id":"aiball-windows"}`. Decoded by the engine. */
    actionData: text("action_data").notNull().default("{}"),
    enabled: integer("enabled").notNull().default(1),
    position: integer("position").notNull().default(0),
    note: text("note"),
    createdAt: text("created_at").notNull(),
    /** #457 slice 5.1 — compositional condition tree (JSON). Nullable :
     *  rules pre-slice-5 keep their flat `match_*` columns, and on read the
     *  decoder synthesizes an equivalent `AND`-of-leaves tree from those
     *  columns when this is NULL. New rules (UI/API/YAML) write a tree here
     *  directly. The `match_*` columns stay around for one bake cycle, then
     *  a follow-up slice can backfill + drop them. */
    expression: text("expression"),
    /** #457 slice 5.4 — stack of actions, JSON array of `{kind, ...data}`.
     *  Defaults to '[]' for legacy rows (the rowToRule decoder then falls
     *  back to synthesizing a single-element array from `action_kind` +
     *  `action_data`). New rules write the canonical array here ; the legacy
     *  pair is mirrored from the first action for one bake cycle. */
    actions: text("actions").notNull().default("[]"),
}, (t) => [
    index("idx_automation_rules_scope_consumer").on(t.scopeConsumer),
]);

// #449: generic config OVERRIDES — the storage half of the unified config
// manager. The schema (keys/scope/type/default/protected) lives in code
// (src/config/schema.ts); this table only holds a key's override at a layer.
// `project=''` is the GLOBAL layer; a non-empty project is that project's layer.
// Layered read: project override → global override → schema default.
export const configOverrides = sqliteTable("config_overrides", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** '' = global layer; otherwise the project name (project layer). */
    project: text("project").notNull().default(""),
    /** A schema key, e.g. 'tickets.default_priority'. */
    key: text("key").notNull(),
    /** JSON-encoded value (number / boolean / string / enum share one column). */
    value: text("value").notNull(),
    updatedAt: text("updated_at").notNull(),
    updatedBy: text("updated_by"),
}, (t) => [
    uniqueIndex("idx_config_overrides_uniq").on(t.project, t.key),
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
    /**
     * Subscription level:
     *   - "owner"    : pings on every ticket movement in the project
     *                  (internal + broadcast). For agents that maintain
     *                  the project.
     *   - "follower" : pings only on broadcast-flagged tickets. Default
     *                  for external agents that subscribed to stay aware
     *                  of public API / behavior changes without drowning
     *                  in internal dev chatter.
     *
     * Ticket-level subscriptions (ticket_subscriptions) always override:
     * if you explicitly follow a thread, you get every ping on it
     * regardless of broadcast state.
     */
    role: text("role").notNull().default("follower"),
}, (t) => [
    primaryKey({ columns: [t.consumerId, t.project] }),
    index("idx_subscriptions_project").on(t.project),
]);

export const ticketSubscriptions = sqliteTable("ticket_subscriptions", {
    consumerId: text("consumer_id").notNull(),
    ticketId: integer("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    subscribedAt: text("subscribed_at").notNull(),
    // #352: 1 = mute. A muted row suppresses pings for this consumer on this
    // ticket EVEN when they'd otherwise be pinged by project-owner/subscriber
    // role (fanOutPings honors it). 0 = explicit follow. No row = role-default.
    muted: integer("muted").notNull().default(0),
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
/**
 * Personal notifications. Each row says "consumer X has an unseen event
 * pointing at <target>". Target is polymorphic but expressed as two
 * mutually-exclusive columns rather than a single shared-counter id
 * (#B.NNN used to look sparse for that reason — see migration 0007).
 * Exactly one of `ticketId` / `commentId` is set per row; the schema
 * CHECK enforces the invariant.
 */
export const pings = sqliteTable("pings", {
    recipient: text("recipient").notNull(),
    /** Set when the ping points at a ticket root (ticket_created /
     *  ticket_closed / ticket_resolved / ticket_reopened on the ticket
     *  itself). NULL for comment pings. */
    ticketId: integer("ticket_id"),
    /** Set when the ping points at a comment in a thread. NULL for
     *  ticket-level pings. */
    commentId: integer("comment_id"),
    /**
     * #296: who CAUSED this ping (the post author for fan-out, the decider
     * for a decision/moderation notification). The self-ping filter hides a
     * ping only when `actor == recipient` — so a decision taken by SOMEONE
     * ELSE on your comment is no longer mistaken for a self-ping and is
     * surfaced/woken. NULL on legacy rows (treated as non-self → shown).
     */
    actor: text("actor"),
    createdAt: text("created_at").notNull(),
    seenAt: text("seen_at"),
}, (t) => [
    index("idx_pings_recipient_unread").on(t.recipient),
]);

export const settings = sqliteTable("settings", {
    key: text("key").primaryKey(),
    value: text("value"),
});

/**
 * Tracking table for files uploaded via POST /api/uploads (per #B.76).
 * Storage is content-addressable on disk (<AIBALL_HOME>/uploads/<sha>.<ext>);
 * this row is *just metadata* — useful for orphan GC, "who uploaded what"
 * queries, and a future "my uploads" panel.
 *
 * Orphan rule: a row whose `sha` is no longer referenced by any
 * `_messages.body` / `tickets.body` is a candidate for deletion. A grace
 * period (`uploaded but not yet referenced because the user is still
 * editing the message`) is enforced at GC time, not at the row level.
 */
export const uploads = sqliteTable("uploads", {
    sha: text("sha").primaryKey(),
    ext: text("ext").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    byAgent: text("by_agent"),
    originalName: text("original_name"),
    createdAt: text("created_at").notNull(),
}, (t) => [
    index("idx_uploads_created").on(t.createdAt),
    index("idx_uploads_by_agent").on(t.byAgent),
]);

/**
 * Consumer registry (#B.79). Every `consumer_id` the daemon has seen
 * gets a row; `kind` says whether it's a human moderator or an agent
 * (or another type if we extend later). The literal `"human"` row is
 * backfilled by migration 0011 so historic bypass code keeps working
 * without reconfiguration.
 *
 * Renamed from `actors` in migration 0012 to match the rest of the
 * codebase / UI which already used "consumer" everywhere.
 */
export const consumers = sqliteTable("consumers", {
    consumerId: text("consumer_id").primaryKey(),
    kind: text("kind").notNull().default("agent"),
    displayName: text("display_name"),
    /** 1 = active, 0 = blocked. Blocking refuses future writes but
     *  leaves historic content intact. */
    enabled: integer("enabled").notNull().default(1),
    note: text("note"),
    /**
     * #397: a per-consumer "micro-prompt" — a short standing instruction the
     * operator edits in the UI (e.g. "branche main si le ticket ne précise
     * pas"). Surfaced to the agent on wake via the `{consumer_prompt}`
     * placeholder in the `prompts:` wake templates. NULL = none (opt-in).
     */
    microPrompt: text("micro_prompt"),
    /**
     * scrypt password hash (#B.94). Set for humans who go through the
     * web /setup or /login flow. NULL for agents (they auth via
     * agent-tokens, no password).
     */
    passwordHash: text("password_hash"),
    /** ISO8601 of the last successful login. NULL if never logged in. */
    lastLoginAt: text("last_login_at"),
    /**
     * ISO8601 of the last API request this consumer made (#B.177).
     * Touched on every request that carries `x-aiball-consumer` /
     * resolves to this id. Surfaced in the consumers panel as
     * "Last seen 2 min ago".
     */
    lastSeenAt: text("last_seen_at"),
    /**
     * Current claude-loop state pushed by the timer (#B.177 B1):
     * `boot` / `idle` / `busy`. NULL when the consumer isn't a
     * claude-loop agent (humans, ephemeral sandboxes).
     */
    state: text("state"),
    /** ISO8601 of the LAST TRANSITION into the current state. */
    stateSince: text("state_since"),
    /**
     * ISO8601 of the last state heartbeat (timer pushes every tick
     * regardless of transition). Used by the UI to detect "offline"
     * (no heartbeat in the last 60s) — distinct from `lastSeenAt`
     * which moves on any API call (e.g. an MCP `ticket_get`).
     */
    stateUpdatedAt: text("state_updated_at"),
    /**
     * #280: live human-presence flag pushed alongside `state` on each
     * heartbeat. 1 = a human is currently driving this loop (typing /
     * within user-grace), 0 = autonomous. NULL when never reported
     * (legacy rows, non-loop consumers). Lets the consumers page show
     * `human` vs `loop` even while the heartbeat is fresh.
     */
    stateHuman: integer("state_human"),
    /**
     * #310: the 3-state human-presence WORD pushed alongside `state` —
     * `stop` (human typing) / `wait` (user-grace or boot-grace, auto-pings
     * frozen) / `loop` (autonomous). Mirrors the tmux bar's presence chip so
     * the consumers page shows the same vocabulary. NULL when never reported
     * (legacy rows, non-loop consumers, or a loop still on the pre-#310 timer
     * that only pushes the `state_human` boolean).
     */
    stateHumanWord: text("state_human_word"),
    /**
     * #393: the loop's working directory (project root), pushed by the
     * state heartbeat. Lets the daemon mark a project "local" (a loop is
     * running here, root known) and offer to launch claude-loop for it.
     * NULL for humans, non-loop consumers, and pre-#393 loops.
     */
    cwd: text("cwd"),
    /**
     * #393 (Option A): the loop's project, pushed alongside `cwd` by the
     * state heartbeat. Lets the daemon attribute the root to EXACTLY this
     * project (root↔project) instead of the broad authored-content heuristic
     * that over-tags every project the consumer ever posted on. NULL for
     * humans, non-loop consumers, and pre-Option-A loops (→ authored-content
     * fallback in listProjectsDetailed).
     */
    project: text("project"),
    /**
     * #422: transport this consumer was last seen on — `uds` (local same-uid
     * Unix socket) / `tcp` (direct bearer over TCP) / `node` (relayed by a
     * trusted proxy node). Stamped at auth on every request. Lets the daemon
     * tell a REMOTE agent from a local one. `lastSeenIp` = the peer address for
     * tcp/node (NULL for uds). Both are last-seen / per-connection, not sticky.
     */
    lastSeenVia: text("last_seen_via"),
    lastSeenIp: text("last_seen_ip"),
    /**
     * #508 david `xc967a` — global per-consumer flag : 1 (défaut) = peut
     * claim normalement via `ticket_engage` / le pool claimable. 0 = consumer
     * spécialiste (assignment-only) : engage skip le pool global et ne
     * retourne QUE les tickets explicitement assignés à ce consumer. Peut
     * toujours recevoir un push d'assignement, commenter, resolved/close,
     * etc. Édité dans `ConsumerEditPage`. Phase A2 ajoutera un override
     * project-level dans `.aiball.yaml`.
     */
    canClaim: integer("can_claim").notNull().default(1),
    /**
     * #516 david `r59bkm` plan E — tri-state opt-in pour recevoir les
     * broadcasts projet (fanOutPings scope='broadcast' follower fan-out).
     * NULL = auto (suit canClaim : claim-able reçoit les broadcasts comme
     * avant ; no_claim ne les reçoit pas). 1 = opt-in explicite. 0 =
     * opt-out explicite. Édité dans ConsumerEditPage. Migration 0044.
     */
    notifyProjectBroadcasts: integer("notify_project_broadcasts"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
}, (t) => [
    index("idx_consumers_kind").on(t.kind),
]);

/**
 * Bearer-token auth (#B.94). Three kinds share the same table so the
 * middleware does one lookup. `install` is one-shot (consumed by the
 * /setup endpoint). `auth` + `agent` are long-lived.
 */
export const tokens = sqliteTable("tokens", {
    token: text("token").primaryKey(),
    consumerId: text("consumer_id").references(() => consumers.consumerId, {
        onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    label: text("label"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    expiresAt: text("expires_at"),
    /** #424: peer IP stamped when a `node` token relays — the proxy node's
     *  address. Lets the Nodes panel show it + group the consumers it relays
     *  (consumers.last_seen_via='node' with matching last_seen_ip). NULL for
     *  non-node tokens and nodes never used since the column landed. */
    lastSeenIp: text("last_seen_ip"),
    /** #524: provider-resolved hostname the node ships in the WS `hello` frame.
     *  Each provider (tailscale → hostname → …) knows how to give a "correct"
     *  name (tailscale = `Self.HostName`, generic = `os.hostname()`). NULL =
     *  node never advertised, or non-node token. The companion `displayHostProvider`
     *  identifies which provider resolved it (`"tailscale"` / `"hostname"` / …),
     *  used by the UI to render a tiny provider chip beside the host. */
    displayHost: text("display_host"),
    displayHostProvider: text("display_host_provider"),
}, (t) => [
    index("idx_tokens_consumer").on(t.consumerId),
    index("idx_tokens_kind").on(t.kind),
]);

/**
 * #404 — per-ticket token-effort tally. The claude-loop Stop-hook reads each
 * turn's `usage` from the Claude session transcript and pushes the delta,
 * attributed to the active ticket (last ticket-scoped MCP call). Raw counts
 * accumulate here; the UI/MCP derive a cost estimate (cache_r is cheap, ~0.1×).
 * Statistical by design (turn-level granularity, multi-ticket turns → active).
 */
export const ticketTokenUsage = sqliteTable("ticket_token_usage", {
    ticketId: integer("ticket_id").primaryKey().references(() => tickets.id, { onDelete: "cascade" }),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    cacheW: integer("cache_w").notNull().default(0),
    cacheR: integer("cache_r").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
});

/**
 * #634 david `svzkpw` — per-project DIRECT token-effort tally. Sink for
 * the Stop-hook's `no-marker` path : a turn that ran outside any
 * ticket-scoped MCP call (user typed a prompt directly, no engage, no
 * tool call setting `active-ticket`). Tokens land here keyed by the
 * loop's AIBALL_PROJECT env. Project cost = SUM(ticket usage in project)
 * + this row.
 */
export const projectTokenUsage = sqliteTable("project_token_usage", {
    project: text("project").primaryKey(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    cacheW: integer("cache_w").notNull().default(0),
    cacheR: integer("cache_r").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
});

// ---- inferred types ------------------------------------------------------

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;

export type Rule = typeof rules.$inferSelect;
export type NewRuleRow = typeof rules.$inferInsert;

export type WorkFilterRow = typeof workFilters.$inferSelect;
export type NewWorkFilterRow = typeof workFilters.$inferInsert;

export type AutomationRuleRow = typeof automationRules.$inferSelect;
export type NewAutomationRuleRow = typeof automationRules.$inferInsert;

export type ConfigOverrideRow = typeof configOverrides.$inferSelect;
export type NewConfigOverrideRow = typeof configOverrides.$inferInsert;

export type Tag = typeof tags.$inferSelect;
export type NewTagRow = typeof tags.$inferInsert;

export type Subscription = typeof subscriptions.$inferSelect;
export type TicketSubscription = typeof ticketSubscriptions.$inferSelect;
export type Ping = typeof pings.$inferSelect;

export type Consumer = typeof consumers.$inferSelect;
export type NewConsumerRow = typeof consumers.$inferInsert;

export type Token = typeof tokens.$inferSelect;
export type NewTokenRow = typeof tokens.$inferInsert;

export type TicketTokenUsage = typeof ticketTokenUsage.$inferSelect;
export type ProjectTokenUsage = typeof projectTokenUsage.$inferSelect;
