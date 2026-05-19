/**
 * Public API of the data layer. Phase A of #B.332 split the original
 * 2000-LOC monolith into per-domain modules under `src/db/`; this file
 * is now a barrel that re-exports everything so callers (api.ts,
 * mcp.ts, messages.ts, search.ts, daemon.ts, …) keep importing from
 * "./db.js" unchanged.
 *
 * If you're adding a new helper, put it in the matching sub-module
 * and re-export it from here.
 */

export {
    getDb,
    getRawSqlite,
    nowIso,
    INTENTS,
    PRIORITIES,
    type Message,
    type MessageKind,
    type MessageStatus,
    type RuleDecision,
    type Intent,
    type Priority,
    type TicketRow,
    type MessageRow,
    type SubscriptionRole,
    type Subscription,
    type Rule,
    type NewMessage,
    type NewRule,
} from "./db/connection.js";

export {
    DEFAULT_STRATEGY,
    STRATEGIES,
    type Strategy,
    getSetting,
    setSetting,
    getStrategy,
    setStrategy,
    getProjectStrategy,
    setProjectStrategy,
    effectiveStrategy,
    UPLOAD_HARD_CAP_BYTES,
    DEFAULT_UPLOAD_MAX_BYTES,
    getUploadMaxBytes,
    setUploadMaxBytes,
} from "./db/settings.js";

export {
    type UploadRow,
    type UploadInsert,
    type UploadStats,
    insertUpload,
    uploadStats,
    listOrphanUploads,
    deleteUploadRow,
} from "./db/uploads.js";

export {
    type Tag,
    type NewTag,
    listTags,
    getTag,
    getTagByName,
    insertTag,
    updateTag,
    deleteTag,
    listMessageTags,
    tagsForMessages,
    addMessageTag,
    removeMessageTag,
    setMessageTags,
} from "./db/tags.js";

export {
    insertMessage,
    insertRelationEvent,
    insertTypedRelation,
    listTypedRelationsForTicket,
    backfillParentTicketRelations,
    type ActiveRelation,
    getMessage,
    getMessageByHashid,
    listMessages,
    listPendingLifecycleForTicket,
    listPendingResolvedForTicket,
    updateMessageStatus,
    editMessage,
    noteMessage,
    markQuestionAnswered,
    applyMessageDecision,
    reclassifyMessageDecision,
    setMessageSummary,
    listPendingResolutionDecisionsForTicket,
} from "./db/messages.js";

export {
    type NewProjectInput,
    type ProjectMeta,
    type ProjectStatsRich,
    createProject,
    deleteProject,
    getProject,
    getProjectStatsRich,
    listProjects,
    listProjectsDetailed,
    purgeOldClosedTickets,
} from "./db/projects.js";

export {
    insertRule,
    listRules,
    deleteRule,
    setRuleEnabled,
} from "./db/rules.js";

export {
    type ProjectStats,
    upsertSubscription,
    deleteSubscription,
    listSubscriptions,
    listProjectSubscribers,
    getProjectStats,
    upsertTicketSubscription,
    deleteTicketSubscription,
    listTicketSubscribers,
    listTicketSubscriptions,
    listKnownAgents,
} from "./db/subscriptions.js";

export {
    isTicketBroadcast,
    setTicketBroadcast,
    setTicketPostpone,
    getTicketPostpone,
    listExpiredPostpones,
    listSubTickets,
    subTicketCounts,
    getTicketStages,
    getTicketBookends,
    type SubTicketSummary,
    type TicketStage,
    type TicketBookend,
} from "./db/tickets.js";

export {
    type Ping,
    insertPing,
    deletePingsForMessage,
    markMessageSeen,
    markAllSeenForProject,
    markTicketSeen,
    markTicketUnseen,
    markSeenUpToForProject,
    markPingsRead,
    listUnread,
    pendingTicketsByAuthor,
    unreadCount,
    ticketUnreadFlags,
    listPings,
    unreadPingCount,
} from "./db/pings.js";

export {
    listConsumers,
    getConsumer,
    ensureConsumer,
    isHuman,
    listHumans,
    updateConsumer,
    upsertConsumer,
    deleteConsumer,
    getConsumersByIds,
    getPasswordHash,
    setPasswordHash,
    touchLastLogin,
    touchLastSeen,
    setConsumerState,
    type Consumer,
    type ConsumerKind,
    type ConsumerState,
} from "./db/consumers.js";

export {
    generateTokenString,
    issueToken,
    getToken,
    getTokenAndTouch,
    deleteToken,
    listTokens,
    purgeExpiredTokens,
    anyHumanCredentials,
    type Token,
    type TokenKind,
} from "./db/tokens.js";
