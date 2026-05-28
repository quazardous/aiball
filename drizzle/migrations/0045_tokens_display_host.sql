-- #524 david `5w37f2` — chaque node ship son nom "correct" via le hello WS ;
-- chaque provider sait comment résoudre son hostname (tailscale, hostname, ...).
-- Deux colonnes optionnelles sur tokens (NULL = node never advertised, ou
-- token non-node) : display_host (string), display_host_provider (string id
-- du provider qui l'a fourni, sert au chip UI).
ALTER TABLE tokens ADD COLUMN display_host TEXT;--> statement-breakpoint
ALTER TABLE tokens ADD COLUMN display_host_provider TEXT;
