-- #2074 — pairing requests from a proxy node awaiting a human's approval.
--
-- A node has no credential yet when it asks, so the request arrives on an
-- unauthenticated route. This table is what keeps that door narrow: a request
-- records an INTENT and nothing else. No token exists until a human approves,
-- which is the same authority that minted it by hand before.
--
-- Separate from `tokens` on purpose. A row here is not a credential and must
-- never be mistaken for one; the token lands in `tokens` like every other, and
-- is referenced from here only long enough to be collected once.
CREATE TABLE IF NOT EXISTS node_enrollments (
    -- Opaque handle handed to the node so it can poll for its answer. Not a
    -- secret: knowing it lets you watch a request, never approve one.
    id TEXT PRIMARY KEY,
    -- The short code shown on both screens. It does not protect the door — it
    -- protects the HUMAN, by proving the row being approved belongs to the
    -- machine in front of them rather than to someone else's request that
    -- arrived at the same moment.
    code TEXT NOT NULL,
    -- What the node calls itself. Advisory, and shown as such: it is chosen by
    -- the party asking, so it is a hint, not evidence.
    label TEXT,
    -- Where the request came from. The one piece of evidence the hub observes
    -- itself rather than being told.
    requested_ip TEXT,
    created_at TEXT NOT NULL,
    -- An unattended request stops being a door. Short by design.
    expires_at TEXT NOT NULL,
    -- 'pending' | 'approved' | 'rejected'. Expiry is derived from the dates
    -- rather than stored, so a clock skew or a missed sweep cannot leave a row
    -- claiming to be live when it is not.
    status TEXT NOT NULL DEFAULT 'pending',
    decided_at TEXT,
    decided_by TEXT,
    -- Minted at approval, collected once. Nulled on collection so a stale row
    -- can never serve a credential twice.
    token TEXT,
    delivered_at TEXT
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_node_enrollments_status ON node_enrollments(status);
