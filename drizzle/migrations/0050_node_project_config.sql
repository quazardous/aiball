CREATE TABLE node_project_config (
  node_token TEXT NOT NULL,
  project TEXT NOT NULL,
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (node_token, project)
);--> statement-breakpoint
CREATE INDEX idx_npc_token ON node_project_config(node_token);
