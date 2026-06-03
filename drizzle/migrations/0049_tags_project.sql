CREATE TABLE tags_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL,
  project TEXT
);--> statement-breakpoint
INSERT INTO tags_new (id, name, color, position, note, created_at, project) SELECT id, name, color, position, note, created_at, NULL FROM tags;--> statement-breakpoint
DROP TABLE tags;--> statement-breakpoint
ALTER TABLE tags_new RENAME TO tags;--> statement-breakpoint
CREATE INDEX idx_tags_position ON tags(position);--> statement-breakpoint
CREATE UNIQUE INDEX idx_tags_name_project ON tags(name, project);
