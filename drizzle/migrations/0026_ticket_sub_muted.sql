-- #352: per-ticket mute. A ticket_subscriptions row with muted=1 suppresses
-- pings for that consumer on that ticket EVEN when they'd otherwise be pinged
-- by project-owner/subscriber role (fanOutPings honors it). Default 0 keeps
-- every existing row as an explicit follow (no behaviour change on backfill).
ALTER TABLE `ticket_subscriptions` ADD `muted` integer NOT NULL DEFAULT 0;
