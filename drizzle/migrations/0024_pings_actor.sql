-- #296: record who CAUSED each ping (the actor). The self-ping filter used
-- to hide any ping whose underlying message was authored by the recipient,
-- which wrongly suppressed decision notifications: a plan/resolution accepted
-- by SOMEONE ELSE pings the author about their OWN comment, so it looked like
-- a self-ping and was filtered → the proposing agent was never woken (#296).
-- With `actor`, a ping is a self-ping only when `actor == recipient`, so a
-- decision taken by another consumer correctly reaches (and wakes) the author.
-- Nullable: legacy rows have no actor (treated as non-self → shown).
ALTER TABLE `pings` ADD `actor` text;
