-- #310: the 3-state human-presence WORD (stop/wait/loop) pushed by the
-- claude-loop timer alongside `state` and the legacy `state_human` boolean.
-- Lets the consumers page mirror the tmux bar's presence tag (loop/wait/stop),
-- not just the binary human flag. Nullable: null = never reported (legacy rows,
-- non-loop consumers, or a loop still on the pre-#310 timer).
ALTER TABLE `consumers` ADD `state_human_word` text;
