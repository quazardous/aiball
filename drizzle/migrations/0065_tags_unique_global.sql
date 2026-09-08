-- #2122 — make the tag uniqueness constraint actually constrain.
--
-- `idx_tags_name_project` has been UNIQUE on (name, project) since project
-- scoping landed, and the codebase reads it as the guarantee that a tag name
-- appears once. It never held for the ones that matter: a GLOBAL tag has
-- `project` NULL, and SQLite treats NULLs as DISTINCT in a unique index, so
-- ('bug', NULL) and ('bug', NULL) are two different keys. Every global tag —
-- the entire shipped catalog — was unconstrained.
--
-- Nothing had exercised it, because the only writer that mattered (POST
-- /api/tags) checks for an existing name in application code first. The gap
-- surfaced the moment something inserted without that check.
--
-- Two halves, and the second is why this is a migration rather than a cleanup:
--
--   1. Collapse the duplicates that exist, keeping the LOWEST id of each name
--      so existing associations survive, and moving any association that
--      pointed at a doomed row onto the survivor first.
--   2. Replace the index with one keyed on IFNULL(project, ''), which folds
--      NULL into a real value and so applies to global tags. Project-scoped
--      tags are unaffected: ('win','a') and ('win','b') stay distinct, which
--      is the case the original index was written for.
--
-- On any database that never had duplicates, step 1 is a no-op and this
-- migration is purely the corrected index.

-- Move associations off the duplicates onto the surviving row. OR IGNORE
-- because (ticket_id, tag_id) is a primary key: a ticket carrying both copies
-- of the same tag keeps the one it already has.
INSERT OR IGNORE INTO ticket_tags (ticket_id, tag_id, set_at, set_by)
SELECT tt.ticket_id, canon.id, tt.set_at, tt.set_by
FROM ticket_tags tt
JOIN tags dup ON dup.id = tt.tag_id
JOIN (
    SELECT MIN(id) AS id, name, IFNULL(project, '') AS proj
    FROM tags GROUP BY name, IFNULL(project, '')
) canon ON canon.name = dup.name AND canon.proj = IFNULL(dup.project, '')
WHERE dup.id <> canon.id;--> statement-breakpoint

-- Drop what pointed at the doomed rows. Explicit rather than left to the
-- foreign key's ON DELETE CASCADE, which depends on a pragma the migrator
-- does not guarantee inside its transaction.
DELETE FROM ticket_tags
WHERE tag_id NOT IN (SELECT MIN(id) FROM tags GROUP BY name, IFNULL(project, ''));--> statement-breakpoint

DELETE FROM tags
WHERE id NOT IN (SELECT MIN(id) FROM tags GROUP BY name, IFNULL(project, ''));--> statement-breakpoint

DROP INDEX IF EXISTS idx_tags_name_project;--> statement-breakpoint

CREATE UNIQUE INDEX idx_tags_name_project ON tags(name, IFNULL(project, ''));
