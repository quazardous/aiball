/**
 * #1588 — the top-level subcommand gate.
 *
 * `claude-loop` rejects an unknown subcommand rather than letting it fall
 * through to `start`, where it would be read as a loop name and boot something
 * nobody asked for.
 *
 * A leaf module because `cli.ts` runs `main()` on import, so nothing can test
 * a predicate that lives there.
 */
import type { Command } from "commander";

/**
 * Is `sub` a subcommand this CLI actually registered?
 *
 * Derived from the built `Command` — names plus aliases — so registering a
 * command is the single act that makes it reachable. This used to be a literal
 * list kept far from the registrations, and the failure was silent in the
 * worst direction: a command could be registered, work when called through
 * commander, and still die on "unknown subcommand" because the second place
 * went unupdated. A list of cases needs whatever produced the cases to produce
 * the list.
 *
 * `help` is commander's own built-in and never appears in `.commands`, so it
 * is the one name the derivation cannot see.
 */
export function isKnownSubcommand(program: Command, sub: string): boolean {
    if (sub === "help") return true;
    return program.commands.some((c) => c.name() === sub || c.aliases().includes(sub));
}
