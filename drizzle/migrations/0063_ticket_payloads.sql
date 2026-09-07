-- #2109 — a payload zone on a ticket, of which a secret-bearing one is a kind.
--
-- david's framing, arrived at in three passes: not a class of ticket, not an
-- intent, but a ZONE that any ordinary ticket may carry. A ticket without one
-- is exactly the ticket of yesterday, so the 99% pay nothing. That is why this
-- is its own table rather than a column: nothing joins it, and no existing read
-- path changes shape because a payload exists somewhere.
--
-- NOT in `tickets.meta`, deliberately. `meta` travels with the row in every
-- response — it is the sidecar the flags and decisions ride on — so a secret
-- placed there would be readable by everything that reads a ticket, including
-- the agents the zone exists to keep out. A separate table is what makes
-- "never joined by default" a property of the schema instead of a promise
-- every future query has to remember to keep.
--
-- The schema column is the interesting half. It lists the keys that are
-- PUBLIC. Written that way, david's rule — "if the schema is not provided,
-- everything is secret" — stops being a special case and becomes the
-- consequence of an empty list: there is no branch to code, and none to
-- forget. A dump therefore shows the KEYS of a payload it may not show the
-- values of, which is what makes an unreadable secret still auditable.
--
-- `revoked_at` follows the tombstone pattern this codebase adopted for node
-- revocations one migration ago (0062): the value is destroyed, the trace that
-- it existed is kept. A vault whose rows vanish silently would leave the same
-- "did my click work?" ambiguity that tombstone was written to end.
CREATE TABLE IF NOT EXISTS ticket_payloads (
    ticket_id INTEGER PRIMARY KEY,
    -- JSON object, key -> value. NULL once revoked: revocation destroys the
    -- values and keeps the row, so the ticket can still say a payload was
    -- here without being able to hand it back.
    payload TEXT,
    -- JSON array of the key names that are PUBLIC. NULL or [] => every key is
    -- secret. Never a list of the secret ones: the safe default has to be the
    -- one you get by saying nothing.
    schema TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- Who deposited. This is an audit of a credential entering the system.
    by_agent TEXT,
    revoked_at TEXT,
    revoked_by TEXT
);
