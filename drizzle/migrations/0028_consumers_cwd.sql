-- #393: per-consumer working directory (the loop's root), pushed by
-- claude-loop's state heartbeat. Lets the daemon mark a project "local"
-- (a loop runs here, root known) and offer to launch claude-loop for it.
ALTER TABLE consumers ADD COLUMN cwd TEXT;
