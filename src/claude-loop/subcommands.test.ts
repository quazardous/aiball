/**
 * #1588 — the top-level subcommand gate.
 *
 * `claude-loop` rejects an unknown subcommand rather than letting it fall
 * through to `start`, where it would be read as a loop name and boot something
 * nobody asked for. That gate used to consult a hand-written list living far
 * from the registrations, and the failure was silent in the worst direction: a
 * command could be registered, work, and still die on "unknown subcommand".
 *
 * The list is now derived from the built `Command`, so these tests pin the
 * contract rather than an inventory.
 *
 * Run: `npx tsx --test src/claude-loop/subcommands.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { isKnownSubcommand } from "./subcommands.js";

function program(): Command {
    const p = new Command().name("claude-loop");
    p.command("start");
    p.command("snapshot");
    p.command("capture").alias("cap");
    return p;
}

test("a registered command is known — registering is the only act required", () => {
    assert.equal(isKnownSubcommand(program(), "start"), true);
    assert.equal(isKnownSubcommand(program(), "capture"), true);
});

test("an alias is known too", () => {
    assert.equal(isKnownSubcommand(program(), "cap"), true);
});

test("`help` is known although commander never lists it", () => {
    // It is built in, so it is absent from `.commands` — the one case the
    // derivation cannot see, and therefore the one worth stating.
    assert.equal(program().commands.some((c) => c.name() === "help"), false);
    assert.equal(isKnownSubcommand(program(), "help"), true);
});

test("anything else is not known", () => {
    assert.equal(isKnownSubcommand(program(), "nonesuch"), false);
    assert.equal(isKnownSubcommand(program(), ""), false);
});
