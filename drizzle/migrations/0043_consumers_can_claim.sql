-- #508 david `xc967a` — global per-consumer flag pour rendre certains
-- consumers "assignment-only" (ne claim PAS le pool global, prennent
-- uniquement ce qui leur est explicitement assigné). 1 = peut claim (défaut,
-- comportement actuel préservé), 0 = no-claim.
--
-- Édité dans ConsumerEditPage. La phase A2 ajoutera un override per-projet
-- via `.aiball.yaml` (`no_claim_consumers: [...]`), sans changer ce schéma.
ALTER TABLE consumers ADD COLUMN can_claim INTEGER NOT NULL DEFAULT 1;
