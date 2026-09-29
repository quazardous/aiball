/**
 * #3138 — the config duration notation, written back: largest units first
 * (`1h30m`, `2d`, `0`). #3250 — the daemon's own (src/config/duration.ts),
 * shared rather than copied: the page only displays, the daemon parses what is
 * typed.
 */
export { formatDuration } from "@shared/config/duration";
