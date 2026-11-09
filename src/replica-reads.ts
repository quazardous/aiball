/**
 * #4867 / #4868 — the bus's reads that touch nothing: what a node answers from
 * its copy while cut from its master, and what a master still answers while it
 * hands the board over. A write among them would be a bug: a test holds it.
 */
export const BOARD_READS: ReadonlySet<string> = new Set([
    "bus.whoami", "rpc.discover", "bus.subjects", "bus.subscribe", "bus.unsubscribe",
    "ticket.get", "ticket.list", "ticket.bookends", "ticket.subscribers",
    "message.get", "message.list", "message.search",
    "inbox.list", "unread.list", "unread.count", "ping.list", "ping.count",
    "consumer.micro_status", "consumer.get", "consumer.list", "consumer.me", "consumer.backlog",
    "project.list", "project.milestones", "tag.list", "decision.mine", "decision.plans_to_execute",
]);
