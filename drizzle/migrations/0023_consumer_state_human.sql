-- #280: live human-presence flag pushed by the claude-loop timer alongside
-- the busy/idle/boot state. Lets the consumers page distinguish an autonomous
-- loop ("loop") from one a human is currently driving ("human") even while
-- the heartbeat is fresh. Nullable: null = never reported (legacy / non-loop).
ALTER TABLE `consumers` ADD `state_human` integer;
