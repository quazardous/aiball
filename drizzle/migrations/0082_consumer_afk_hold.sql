-- #3594 — an agent's hold (AFK) is its state, kept by aiball even while no
-- loop runs: `off` (the loop works on its own) or `wait_inf` (held). A loop
-- starts in it, a client shows and changes it for an agent without a loop.
ALTER TABLE consumers ADD COLUMN afk_hold TEXT NOT NULL DEFAULT 'off';
