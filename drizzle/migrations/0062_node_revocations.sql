-- #2085 — the trace a revoked node leaves behind.
--
-- Revoking used to make the row disappear, which looks the same as a bug: the
-- only sign the click worked was the absence that followed it. Same complaint
-- as a refused pairing request, same answer — keep it visible for a while.
--
-- A TOMBSTONE, deliberately, rather than a `revoked_at` flag on `tokens`.
-- Revocation stays exactly what it was, a DELETE: the credential ceases to
-- exist, and no authentication path has to learn a new rule to keep honouring
-- it. A flag would mean every query that looks a token up must remember to
-- exclude the revoked ones, and forgetting one of them would leave a revoked
-- node working. This table can be wrong without ever being dangerous — the
-- worst it can do is show a row that should have aged out.
--
-- It carries no secret. `node_id` is the same non-secret handle the panel
-- already uses: sha256(token) truncated, which the token cannot be recovered
-- from.
CREATE TABLE IF NOT EXISTS node_revocations (
    node_id TEXT PRIMARY KEY,
    -- What the panel showed for it, copied at revocation so the row still
    -- reads like the node it replaces rather than like a bare hash.
    label TEXT,
    display_host TEXT,
    display_host_provider TEXT,
    last_seen_ip TEXT,
    -- When the node was first minted, kept so the row can still say how long
    -- it had been around.
    created_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT NOT NULL,
    -- Who clicked. This is an audit of a credential being destroyed.
    revoked_by TEXT
);
