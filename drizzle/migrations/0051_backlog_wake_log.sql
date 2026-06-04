CREATE TABLE backlog_wake_log (
  consumer_id TEXT NOT NULL,
  ticket_id INTEGER NOT NULL,
  wake_at TEXT NOT NULL,
  PRIMARY KEY (consumer_id, ticket_id)
);--> statement-breakpoint
CREATE INDEX idx_bwl_wake_at ON backlog_wake_log(wake_at);
