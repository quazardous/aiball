/**
 * #565 — `welcome` kit builder tests. Uses a throwaway install layout
 * in tmpdir to exercise the discovery + scan paths in isolation from
 * the shipped `welcome/` tree (so tests don't break the day a real
 * template file gets edited).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    availableTypes,
    buildWelcomeKit,
    DEFAULT_PROJECT_TYPE,
    UnknownProjectTypeError,
} from "./welcome.js";

function scaffold(): string {
    // Mirror the shape `installRoot/welcome/<type>/{WELCOME.md,
    // rules/*.md, templates/*}`. Two valid types (public, private), one
    // draft (incomplete = no WELCOME.md), one bogus dotfile-looking
    // entry that must be skipped.
    const root = mkdtempSync(join(tmpdir(), "aiball-welcome-"));
    const w = join(root, "welcome");
    mkdirSync(w, { recursive: true });

    // public — full kit (welcome + 2 rules + 2 templates).
    mkdirSync(join(w, "public", "rules"), { recursive: true });
    mkdirSync(join(w, "public", "templates"), { recursive: true });
    writeFileSync(join(w, "public", "WELCOME.md"), "# Welcome (public)\n\nTone doc for public.\n");
    writeFileSync(
        join(w, "public", "rules", "no-leak.md"),
        "<!--\nintent: zero internal tracker leakage\n-->\n\n# No leak\n\nDon't reference internal tracker IDs in commits.\n",
    );
    writeFileSync(
        join(w, "public", "rules", "license-required.md"),
        "<!-- intent: every public repo carries a LICENSE -->\n\n# License required\n\nDrop a LICENSE file at the root.\n",
    );
    writeFileSync(
        join(w, "public", "templates", "README.md"),
        "<!-- intent: starter readme -->\n# {project}\n",
    );
    writeFileSync(
        join(w, "public", "templates", "CHANGELOG.md"),
        "<!-- intent: keep-a-changelog -->\n# Changelog\n",
    );

    // private — kit with no rules + no templates (lighter type).
    mkdirSync(join(w, "private", "rules"), { recursive: true });
    mkdirSync(join(w, "private", "templates"), { recursive: true });
    writeFileSync(join(w, "private", "WELCOME.md"), "# Welcome (private)\n\nInternal repos.\n");

    // draft — directory without WELCOME.md ⇒ ignored.
    mkdirSync(join(w, "draft"), { recursive: true });

    // .hidden — dotfile-looking entry ⇒ ignored.
    mkdirSync(join(w, ".hidden"), { recursive: true });
    writeFileSync(join(w, ".hidden", "WELCOME.md"), "# nope\n");

    return root;
}

test("availableTypes: lists folders that own a WELCOME.md, sorted", () => {
    const root = scaffold();
    assert.deepEqual(availableTypes(root), ["private", "public"]);
});

test("availableTypes: missing welcome/ → empty list", () => {
    const root = mkdtempSync(join(tmpdir(), "aiball-welcome-empty-"));
    assert.deepEqual(availableTypes(root), []);
});

test("buildWelcomeKit: public type → tone + rules + templates", () => {
    const root = scaffold();
    const kit = buildWelcomeKit(root, "public");
    assert.equal(kit.project_type, "public");
    assert.deepEqual(kit.available_types, ["private", "public"]);
    assert.match(kit.welcome_md, /Tone doc for public/);
    assert.equal(kit.rules.length, 2);
    // Rules sorted alphabetically by filename.
    assert.deepEqual(
        kit.rules.map((r) => r.name),
        ["license-required", "no-leak"],
    );
    // Summary skips HTML comment + heading, picks first plain text line.
    const noLeak = kit.rules.find((r) => r.name === "no-leak");
    assert.equal(noLeak?.summary, "Don't reference internal tracker IDs in commits.");
    // Detail keeps the full body (intent comment included).
    assert.match(noLeak?.detail ?? "", /<!--/);
    assert.equal(kit.templates.length, 2);
    assert.deepEqual(
        kit.templates.map((t) => t.name),
        ["CHANGELOG", "README"],
    );
    const readme = kit.templates.find((t) => t.name === "README");
    assert.equal(readme?.path_hint, "README.md");
    assert.match(readme?.source_md ?? "", /intent: starter readme/);
});

test("buildWelcomeKit: private type → tone only, empty rules/templates", () => {
    const root = scaffold();
    const kit = buildWelcomeKit(root, "private");
    assert.equal(kit.project_type, "private");
    assert.match(kit.welcome_md, /Internal repos/);
    assert.deepEqual(kit.rules, []);
    assert.deepEqual(kit.templates, []);
});

test("buildWelcomeKit: empty/whitespace type → defaults to `public`", () => {
    const root = scaffold();
    const kit = buildWelcomeKit(root, "");
    assert.equal(kit.project_type, "public");
    assert.equal(DEFAULT_PROJECT_TYPE, "public");
});

test("buildWelcomeKit: null type → defaults to `public`", () => {
    const root = scaffold();
    const kit = buildWelcomeKit(root, null);
    assert.equal(kit.project_type, "public");
});

test("buildWelcomeKit: unknown type → UnknownProjectTypeError carrying available_types", () => {
    const root = scaffold();
    let caught: unknown;
    try {
        buildWelcomeKit(root, "totally-invented");
    } catch (e) {
        caught = e;
    }
    assert.ok(caught instanceof UnknownProjectTypeError);
    const err = caught as UnknownProjectTypeError;
    assert.deepEqual(err.availableTypes, ["private", "public"]);
    assert.match(err.message, /unknown project_type "totally-invented"/);
    assert.match(err.message, /available: \[private, public\]/);
});

test("buildWelcomeKit: draft folder (no WELCOME.md) is invisible", () => {
    const root = scaffold();
    let caught: unknown;
    try {
        buildWelcomeKit(root, "draft");
    } catch (e) {
        caught = e;
    }
    assert.ok(caught instanceof UnknownProjectTypeError);
});

test("buildWelcomeKit: extractSummary falls back to heading when no plain text", () => {
    const root = mkdtempSync(join(tmpdir(), "aiball-welcome-headingonly-"));
    const w = join(root, "welcome", "x");
    mkdirSync(join(w, "rules"), { recursive: true });
    writeFileSync(join(w, "WELCOME.md"), "# x\n");
    writeFileSync(
        join(w, "rules", "heading-only.md"),
        "<!-- intent: heading only -->\n\n# Just a heading\n",
    );
    const kit = buildWelcomeKit(root, "x");
    assert.equal(kit.rules[0]?.summary, "Just a heading");
});

test("buildWelcomeKit: extractSummary truncates long first paragraph", () => {
    const root = mkdtempSync(join(tmpdir(), "aiball-welcome-long-"));
    const w = join(root, "welcome", "x");
    mkdirSync(join(w, "rules"), { recursive: true });
    writeFileSync(join(w, "WELCOME.md"), "# x\n");
    const long = "word ".repeat(80).trim();
    writeFileSync(join(w, "rules", "long.md"), `# Title\n\n${long}\n`);
    const kit = buildWelcomeKit(root, "x");
    const s = kit.rules[0]?.summary ?? "";
    assert.ok(s.length <= 200, `summary length ${s.length}`);
    assert.ok(s.endsWith("…"), `summary should end with ellipsis, got ${JSON.stringify(s.slice(-10))}`);
});
