-- #2081 — what the asking machine says it is called.
--
-- The hub observes the peer IP and nothing else, and a local reverse proxy
-- strips the tailnet origin, so every request looks like it came from
-- 127.0.0.1. A node that is already paired solves this by resolving its own
-- host (tailscale, then plain hostname) and shipping it in its WS hello; the
-- pair command runs on that same machine and can say the same thing.
--
-- DELIBERATELY SEPARATE from `requested_ip`. The IP is evidence the hub
-- gathered itself; these two columns are a CLAIM by a party that has proved
-- nothing yet — the request arrives unauthenticated, that is the point of the
-- route. They are stored and displayed as such, next to the label, which is
-- already presented as chosen by the node.
ALTER TABLE node_enrollments ADD COLUMN claimed_host TEXT;--> statement-breakpoint
-- Which provider resolved it on the node ('tailscale', 'hostname', …), so the
-- panel can show the same provider chip a paired node gets.
ALTER TABLE node_enrollments ADD COLUMN claimed_host_provider TEXT;
