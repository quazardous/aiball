-- #1992 — the COMPILED graph. Two tables that are pure cache: every row is
-- derived from the append-only message log, so the whole thing can be dropped
-- and rebuilt at any time without losing anything. A full recompile of the
-- corpus takes ~200 ms, which is why there is no incremental compiler.
--
-- No foreign keys, deliberately: the compiler wipes and refills these tables
-- wholesale, and FK checks during a rebuild would cost time to protect data
-- that has no value of its own. Referential validity holds by construction —
-- the compiler only emits ids it read out of `tickets`.
CREATE TABLE IF NOT EXISTS graph_edges (
    -- The ticket whose prose carries the reference…
    src_ticket_id INTEGER NOT NULL,
    -- …and the ticket it names. Directed: who wrote about whom is information,
    -- and a consumer that wants an undirected view can symmetrise cheaply.
    dst_ticket_id INTEGER NOT NULL,
    -- 'mentions' today. Typed relations stay in the message log where they are
    -- authored; this column is what lets them be folded in later without a
    -- second table.
    kind TEXT NOT NULL,
    -- How many times the pair is named. A pair named once is often decoration;
    -- twice or more is a link, and consumers threshold on this.
    weight INTEGER NOT NULL DEFAULT 1,
    -- THE CITATION, and the reason an edge is allowed to exist at all: the
    -- message this was read from, NULL when it came from the source ticket's
    -- own body or title. A surprising result must trace back to the sentence
    -- that caused it in one hop — an edge nobody can cite is worse than a
    -- missing one, because a missing edge is visible and a false one is not.
    derived_message_id INTEGER,
    -- Offset of the `#` inside that text, so the citation lands on the phrase
    -- rather than on a wall of markdown.
    derived_offset INTEGER,
    PRIMARY KEY (src_ticket_id, dst_ticket_id, kind)
);--> statement-breakpoint
-- The src side is covered by the primary key; the dst side is what answers
-- "who talks about this ticket", which is half of every query we have.
CREATE INDEX IF NOT EXISTS idx_graph_edges_dst ON graph_edges(dst_ticket_id);--> statement-breakpoint
-- The watermark. Not a content hash: computing one means reading the 13 MB of
-- prose the watermark exists to avoid reading. The log is append-only with
-- monotonic ids, so three integers say both THAT it moved and BY HOW MUCH —
-- which is what allows a threshold instead of a recompile per comment.
CREATE TABLE IF NOT EXISTS graph_meta (
    -- Single row, pinned. The compiled artifact has no history worth keeping.
    id INTEGER PRIMARY KEY CHECK (id = 1),
    -- max(_messages.id) — catches appends.
    compiled_through_id INTEGER NOT NULL,
    -- count(*) — catches deletions, which leave max(id) untouched.
    compiled_message_count INTEGER NOT NULL,
    -- count(original_body IS NOT NULL) — catches a body edited in place, which
    -- moves neither of the two above. Known gap, stated rather than hidden: a
    -- SECOND edit of an already-edited message moves nothing, so its edges wait
    -- for the next recompile any other event triggers.
    compiled_edited_count INTEGER NOT NULL,
    compiled_at TEXT NOT NULL,
    edge_count INTEGER NOT NULL
);
