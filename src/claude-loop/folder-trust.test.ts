// #2230 — the start-time trust warning reads Claude Code's per-folder trust.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTrustedIn, readFolderTrust } from "./folder-trust.js";

test("a folder marked trusted is trusted", () => {
    assert.equal(isTrustedIn({ "/w/app": { hasTrustDialogAccepted: true } }, "/w/app"), true);
});

test("a folder under a trusted ancestor is trusted", () => {
    assert.equal(isTrustedIn({ "/w": { hasTrustDialogAccepted: true } }, "/w/app/sub"), true);
});

test("an unknown folder, or one explicitly false, is not trusted", () => {
    assert.equal(isTrustedIn({}, "/tmp/new"), false);
    assert.equal(isTrustedIn({ "/tmp/new": { hasTrustDialogAccepted: false } }, "/tmp/new"), false);
});

test("reads the real file shape from a home directory", () => {
    const home = mkdtempSync(join(tmpdir(), "aiball-trust-"));
    try {
        writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { "/w/ok": { hasTrustDialogAccepted: true } } }));
        assert.equal(readFolderTrust("/w/ok", home), true);
        assert.equal(readFolderTrust("/w/no", home), false);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("no config, or an unreadable one → null, so start stays quiet", () => {
    const home = mkdtempSync(join(tmpdir(), "aiball-trust-"));
    try {
        assert.equal(readFolderTrust("/w/ok", home), null);
        writeFileSync(join(home, ".claude.json"), "{not json");
        assert.equal(readFolderTrust("/w/ok", home), null);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
