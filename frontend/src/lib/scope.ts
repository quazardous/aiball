/**
 * Tristate `scope` (#B.245) visual helpers. Shared between the composer
 * (option icons), the inbox list (per-row badge), and the message
 * cards (per-event badge). Centralized so the three places stay in
 * sync — change a glyph here, every surface follows.
 */

export type Scope = "internal" | "default" | "broadcast";

export const SCOPES: Scope[] = ["internal", "default", "broadcast"];

/**
 * PrimeIcon class (without the leading `pi `) for the given scope.
 * Returns `null` for `default` so the common case stays visually
 * quiet — only the narrowed (`internal`) and amplified (`broadcast`)
 * events surface a badge in the lists and threads.
 */
export function scopeIcon(scope: Scope): string | null {
    switch (scope) {
        case "internal":  return "pi-eye-slash";
        case "broadcast": return "pi-megaphone";
        default:          return null;
    }
}

export function scopeTitle(scope: Scope): string {
    switch (scope) {
        case "internal":
            return "Internal scope — owners only + @mentions (no thread subscribers, no followers). @projet narrows to project owners.";
        case "broadcast":
            return "Broadcast scope — ticket subscribers + project owners + project followers. Use sparingly: pings every follower.";
        default:
            return "Default scope — ticket subscribers + project owners + @mentions. The standard fan-out.";
    }
}

