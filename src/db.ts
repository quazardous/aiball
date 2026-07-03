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
    type ResolvedAttachment,
    insertUpload,
    uploadStats,
    listOrphanUploads,
    deleteUploadRow,
    getUploadBySha,
    getUploadsByShas,
    resolveAttachments,
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
    lineageWouldCycle,
    backfillParentTicketRelations,
    type ActiveRelation,
    getMessage,
    getMessageByHashid,
    listMessages,
    listPendingLifecycleForTicket,
    listPendingResolvedForTicket,
    updateMessageStatus,
    editMessage,
    moveTicket,
    deleteComment,
    noteMessage,
    markQuestionAnswered,
    applyMessageDecision,
    promoteMessageToDecision,
    reclassifyMessageDecision,
    removeMessageDecision,
    setMessageSummary,
    setMessageVote,
    listPendingResolutionDecisionsForTicket,
    listPendingDecisionsForReporter,
    listPlansToExecute,
    type PendingDecisionEntry,
} from "./db/messages.js";

export {
    type NewProjectInput,
    type ProjectMeta,
    type ProjectStatsRich,
    createProject,
    deleteProject,
    renameProject,
    type ProjectRenameResult,
    getProject,
    getProjectStatsRich,
    listProjects,
    listProjectsDetailed,
    isRootActive,
    purgeOldClosedTickets,
    getGlobalCounts,
    recordBacklogWake,
    backlogCooldownExclusions,
} from "./db/projects.js";

export {
    insertRule,
    listRules,
    deleteRule,
    setRuleEnabled,
} from "./db/rules.js";

export {
    insertWorkFilter,
    listWorkFilters,
    deleteWorkFilter,
    setWorkFilterEnabled,
    type WorkFilter,
    type WorkFilterMode,
    type NewWorkFilter,
} from "./db/work-filters.js";

export {
    getConfig,
    getResolvedConfig,
    setConfigOverride,
    deleteConfigOverride,
    resolveConfigValue,
    type ResolvedConfig,
} from "./db/config-overrides.js";

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
    mutedConsumersForTicket,
    getTicketSubscriptionState,
    listTicketSubscriptionsForTicket,
    listKnownAgents,
} from "./db/subscriptions.js";

export {
    getTicketScope,
    setTicketPostpone,
    getTicketPostpone,
    listExpiredPostpones,
    listSubTickets,
    subTicketCounts,
    setTicketOwner,
    setTicketAssignment,
    setTicketClaim,
    ticketsClaimedBy,
    releaseTicketAssignment,
    releaseTicketClaim,
    releaseTicketHold,
    getTicketStages,
    getTicketBookends,
    ticketSelfLastActivity,
    ticketAgentLastActivity,
    type SubTicketSummary,
    type TicketStage,
    type TicketBookend,
} from "./db/tickets.js";
export {
    addTicketTokenUsage,
    addProjectTokenUsage,
    getTicketTokenUsage,
    getProjectTokenUsage,
    type TokenDelta,
    type TokenTally,
} from "./db/token-usage.js";

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
    setTokenLastSeenIp,
    updateTokenLabel,
    listTokens,
    purgeExpiredTokens,
    anyHumanCredentials,
    type Token,
    type TokenKind,
} from "./db/tokens.js";
