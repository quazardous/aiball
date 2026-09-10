-- #2201 — which MCP function tools an agent is shown. NULL = `coder`, i.e. every
-- tool, exactly as before this column existed. Set by a human moderator only
-- (the consumer PATCH guard treats it like can_claim); read by the MCP server at
-- boot to decide which tools to register.
ALTER TABLE consumers ADD COLUMN agent_type TEXT;
