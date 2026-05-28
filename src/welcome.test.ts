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
    getWelcomeTemplate,
    UnknownProjectTypeError,
    UnknownTemplateError,
} from "./welcome.js";

function scaffold(): string {
    // Mirror the shape `installRoot/welcome/<type>/{WELCOME.md,
    // templates/*}`. Two valid types (public, private), one draft
    // (incomplete = no WELCOME.md), one bogus dotfile-looking entry
    // that must be skipped.
    const root = mkdtempSync(join(tmpdir(), "aiball-welcome-"));
    const w = join(root, "welcome");
    mkdirSync(w, { recursive: true });

    // public — full kit (welcome + 2 templates).
    mkdirSync(join(w, "public", "templates"), { recursive: true });
    writeFileSync(
        join(w, "public", "WELCOME.md"),
        "# Welcome (public)\n\nTone doc for public.\n",
    );
    writeFileSync(
        join(w, "public", "templates", "README.md"),
        "<!-- intent: starter readme -->\n# {project}\n",
    );
    writeFileSync(
        join(w, "public", "templates", "CHANGELOG.md"),
        "<!-- intent: keep-a-changelog -->\n# Changelog\n",
    );

    // private — kit with no templates (lighter type).
    mkdirSync(join(w, "private", "templates"), { recursive: true });
    writeFileSync(
        join(w, "private", "WELCOME.md"),
        "# Welcome (private)\n\nInternal repos.\n",
    );

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

test("buildWelcomeKit: public type → tone + template MANIFEST (no bodies, V1.2)", () => {
    const root = scaffold();
    const kit = buildWelcomeKit(root, "public");
    assert.equal(kit.project_type, "public");
    assert.deepEqual(kit.available_types, ["private", "public"]);
    assert.match(kit.welcome_md, /Tone doc for public/);
    assert.equal(kit.templates.length, 2);
    // Templates sorted alphabetically by filename.
    assert.deepEqual(
        kit.templates.map((t) => t.name),
        ["CHANGELOG", "README"],
    );
    const readme = kit.templates.find((t) => t.name === "README");
    assert.equal(readme?.path_hint, "README.md");
    // V1.2 : manifest entry MUST NOT carry source_md inline. Verify the
    // TS interface by index-access (the field literally isn't there) and
    // by checking the JSON shape stays lean.
    assert.ok(!("source_md" in (readme as object)));
});

test("buildWelcomeKit: private type → tone only, empty templates", () => {
    const root = scaffold();
    const kit = buildWelcomeKit(root, "private");
    assert.equal(kit.project_type, "private");
    assert.match(kit.welcome_md, /Internal repos/);
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

test("buildWelcomeKit: type with no templates/ subdir → empty list, no crash", () => {
    const root = mkdtempSync(join(tmpdir(), "aiball-welcome-toneonly-"));
    const w = join(root, "welcome", "tone-only");
    mkdirSync(w, { recursive: true });
    writeFileSync(join(w, "WELCOME.md"), "# Tone only\n\nNo templates here.\n");
    const kit = buildWelcomeKit(root, "tone-only");
    assert.equal(kit.project_type, "tone-only");
    assert.deepEqual(kit.templates, []);
    assert.match(kit.welcome_md, /No templates here/);
});

// ---- getWelcomeTemplate (V1.2 token-effective body fetch) -----------------

test("getWelcomeTemplate: fetches the body verbatim (intent comment kept)", () => {
    const root = scaffold();
    const tpl = getWelcomeTemplate(root, "public", "CHANGELOG");
    assert.equal(tpl.name, "CHANGELOG");
    assert.equal(tpl.path_hint, "CHANGELOG.md");
    assert.match(tpl.source_md, /^<!-- intent: keep-a-changelog -->/);
});

test("getWelcomeTemplate: defaults type to `public` on empty/null/undefined", () => {
    const root = scaffold();
    const a = getWelcomeTemplate(root, "", "README");
    const b = getWelcomeTemplate(root, null, "README");
    const c = getWelcomeTemplate(root, undefined, "README");
    assert.equal(a.name, "README");
    assert.equal(b.name, "README");
    assert.equal(c.name, "README");
});

test("getWelcomeTemplate: unknown template name → UnknownTemplateError carrying availableTemplates", () => {
    const root = scaffold();
    let caught: unknown;
    try {
        getWelcomeTemplate(root, "public", "TOTALLY_INVENTED");
    } catch (e) {
        caught = e;
    }
    assert.ok(caught instanceof UnknownTemplateError);
    const err = caught as UnknownTemplateError;
    assert.deepEqual(err.availableTemplates, ["CHANGELOG", "README"]);
    assert.match(err.message, /unknown template "TOTALLY_INVENTED"/);
    assert.match(err.message, /project_type "public"/);
});

test("getWelcomeTemplate: unknown project_type → UnknownProjectTypeError (not UnknownTemplateError)", () => {
    const root = scaffold();
    let caught: unknown;
    try {
        getWelcomeTemplate(root, "invented-type", "README");
    } catch (e) {
        caught = e;
    }
    assert.ok(caught instanceof UnknownProjectTypeError);
});

test("getWelcomeTemplate: private type has no templates → any name errors", () => {
    const root = scaffold();
    let caught: unknown;
    try {
        getWelcomeTemplate(root, "private", "CHANGELOG");
    } catch (e) {
        caught = e;
    }
    assert.ok(caught instanceof UnknownTemplateError);
    assert.deepEqual((caught as UnknownTemplateError).availableTemplates, []);
});
