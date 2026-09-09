/**
 * #2090 — `aiball init gnome-extension` deploys a DIRECTORY, which is the one
 * way it differs from `init skill`'s single file.
 *
 * That difference is the thing worth pinning: a refresh has to REPLACE the
 * destination, not merge into it. A stale `extension.js` from an older layout,
 * left behind next to the new files, is loaded by the shell all the same —
 * a broken extension with no error pointing at the leftover.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `copyGnomeExtension` rather than `installGnomeExtension`: the latter reports
// through `die()`, which exits the process, so a refusal is only observable as
// a verdict. Testing the exit would test the CLI wrapper, not the decision.
const { copyGnomeExtension, GNOME_EXTENSION_UUID } = await import("./bootstrap.js");

/**
 * Comments are stripped before the credential check below. Without this the
 * assertion matches the prose EXPLAINING why there is no bearer token — a
 * test that fails on its own documentation is testing the wrong artefact.
 */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const targets: string[] = [];
function freshTarget(): string {
    const d = mkdtempSync(join(tmpdir(), "aiball-2090-"));
    targets.push(d);
    return d;
}

test("it lands the whole extension, not just a manifest", () => {
    const target = freshTarget();
    copyGnomeExtension({ target, force: false });
    const dir = join(target, GNOME_EXTENSION_UUID);
    for (const f of ["metadata.json", "extension.js", "aiballClient.js"]) {
        assert.ok(existsSync(join(dir, f)), `${f} is missing — the shell needs all of them`);
    }
});

test("the manifest declares the uuid the directory is named after", () => {
    // GNOME matches the two; a mismatch makes the extension invisible with no
    // error the user can act on.
    const target = freshTarget();
    copyGnomeExtension({ target, force: false });
    const meta = JSON.parse(
        readFileSync(join(target, GNOME_EXTENSION_UUID, "metadata.json"), "utf8"),
    ) as { uuid: string; "shell-version": string[] };
    assert.equal(meta.uuid, GNOME_EXTENSION_UUID);
    assert.ok(meta["shell-version"].length > 0, "an empty shell-version installs nowhere");
});

test("a refresh REPLACES the directory — a stale file does not survive it", () => {
    const target = freshTarget();
    copyGnomeExtension({ target, force: false });
    const dir = join(target, GNOME_EXTENSION_UUID);
    const stale = join(dir, "extensionOldLayout.js");
    writeFileSync(stale, "// left over from a previous version\n", "utf8");

    copyGnomeExtension({ target, force: true });

    assert.ok(!existsSync(stale), "the leftover would be loaded alongside the new files");
    assert.ok(existsSync(join(dir, "extension.js")), "and the real files are back");
});

test("it refuses to clobber without --overwrite", () => {
    const target = freshTarget();
    assert.equal(copyGnomeExtension({ target, force: false }).kind, "installed");
    assert.equal(copyGnomeExtension({ target, force: false }).kind, "skipped-exists");
});

test("the extension holds no token, and asks for none", () => {
    // The whole security argument of #2090 in one assertion: it reads the Unix
    // socket, where same-uid access IS the trust boundary. If it ever grew a
    // bearer header or an Authorization line, it would need a credential to
    // live inside a GNOME extension — which is the thing we refused to do.
    const target = freshTarget();
    copyGnomeExtension({ target, force: false });
    const dir = join(target, GNOME_EXTENSION_UUID);
    for (const f of ["extension.js", "aiballClient.js"]) {
        const src = stripComments(readFileSync(join(dir, f), "utf8"));
        assert.doesNotMatch(src, /Authorization|Bearer|aiball_token|AIBALL_TOKEN/i, `${f}`);
    }
    assert.match(readFileSync(join(dir, "aiballClient.js"), "utf8"), /UnixSocketAddress/);
});

after(() => {
    for (const d of targets) rmSync(d, { recursive: true, force: true });
});
