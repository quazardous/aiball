-- #422: record the transport a consumer was last seen on, so the daemon can
-- tell a REMOTE agent (relayed by a proxy node, or direct over TCP from another
-- host) from a LOCAL one (same-uid over the Unix socket). `last_seen_via` ∈
-- uds | tcp | node; `last_seen_ip` is the peer address for tcp/node (null for
-- uds). Stamped at auth on every request; "remote" is DERIVED (via=node, or
-- tcp from a non-loopback ip). Per-connection / last-seen, not a sticky prop.
ALTER TABLE consumers ADD COLUMN last_seen_via TEXT;--> statement-breakpoint
ALTER TABLE consumers ADD COLUMN last_seen_ip TEXT;
