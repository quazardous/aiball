/**
 * `@name` mentions — the parser, alone.
 *
 * Lived inside `notifications.ts` while the fan-out was its only consumer.
 * #1573 gave it a second one (the backlog rules ask "does this thread address
 * me by name?"), and that consumer sits under `db/` — importing the fan-out
 * module from there would drag the whole notification graph behind a pure
 * string function. So the function moves to a leaf with no imports of its own,
 * and both sides read the same one: a mention must mean exactly the same thing
 * when it creates a ping and when it exempts a ticket from a rule.
 */

/**
 * Extract `@<name>` mentions from a body. Code fences / inline-code spans are
 * stripped first so refs inside them don't fire. Names accept word chars, dash
 * and underscore, 2..64 long.
 *
 * @param selfAgent When set, that name is skipped — the fan-out uses it to
 *   avoid self-pinging the author. Pass `null` to get every mention, which is
 *   what a "does this mention X?" test wants.
 */
export function extractMentions(
    body: string | null | undefined,
    selfAgent: string | null,
): string[] {
    if (!body) return [];
    const stripped = body
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`]*`/g, "");
    const out = new Set<string>();
    // Boundary: start of input or a non-word non-`@` char (so `email@x`
    // and `@@name` don't get caught).
    const re = /(?:^|[^\w@])@([a-zA-Z0-9_-]{2,64})\b/g;
    for (const m of stripped.matchAll(re)) {
        const name = m[1];
        if (selfAgent && name === selfAgent) continue;
        out.add(name);
    }
    return [...out];
}

/** True when `body` addresses `agent` by name. */
export function mentions(body: string | null | undefined, agent: string): boolean {
    return extractMentions(body, null).includes(agent);
}
