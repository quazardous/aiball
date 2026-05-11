CREATE TABLE IF NOT EXISTS uploads (
    sha TEXT PRIMARY KEY,
    ext TEXT NOT NULL,
    content_type TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    by_agent TEXT,
    original_name TEXT,
    created_at TEXT NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_uploads_created ON uploads(created_at);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_uploads_by_agent ON uploads(by_agent);
