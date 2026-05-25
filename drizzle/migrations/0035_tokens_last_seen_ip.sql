-- #424: stamp the proxy node's peer IP on its token when it relays, so the
-- Nodes panel can show each node's address and group the consumers it relays
-- (consumers.last_seen_via='node' + matching last_seen_ip). Node tokens only.
ALTER TABLE tokens ADD COLUMN last_seen_ip TEXT;
