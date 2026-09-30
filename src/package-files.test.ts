/**
 * #3384 — what a packaged script loads must be in the package. The tray
 * dot-sourced `bin/aiball-tray-version.ps1`, which `files` left out: an install
 * from the tarball crashed on `Get-TrayTooltip`; only a checkout had the file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const files = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] }).files;

/** Is `rel` (posix, from the package root) shipped: listed, or under a listed directory? */
function shipped(rel: string): boolean {
    return files.some((f) => !f.startsWith("!") && (f === rel || rel.startsWith(`${f}/`)));
}

/** The sibling files a packaged script loads: PowerShell dot-sources, JS relative imports. */
function loads(rel: string): string[] {
    const text = readFileSync(join(ROOT, rel), "utf8");
    const dir = posix.dirname(rel);
    const out: string[] = [];
    if (rel.endsWith(".ps1")) {
        for (const m of text.matchAll(/^\s*\.\s+\(Join-Path \$PSScriptRoot '([^']+)'\)/gm)) out.push(posix.join(dir, m[1].replace(/\\/g, "/")));
    } else {
        for (const m of text.matchAll(/\bfrom\s+["'](\.\.?\/[^"']+)["']|\bimport\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g)) out.push(posix.join(dir, m[1] ?? m[2]));
    }
    return out;
}

test("every file a packaged bin script loads is in the package", () => {
    const scripts = files.filter((f) => f.startsWith("bin/") && existsSync(join(ROOT, f)));
    assert.ok(scripts.includes("bin/aiball-tray.ps1"), "the tray script is packaged");
    const missing: string[] = [];
    for (const script of scripts) {
        for (const dep of loads(script)) {
            assert.ok(existsSync(join(ROOT, dep)), `${script} loads ${dep}, which does not exist`);
            if (!shipped(dep)) missing.push(`${script} loads ${dep}`);
        }
    }
    assert.deepEqual(missing, [], "loaded by a packaged script, but not in package.json `files`");
});

test("every listed file exists", () => {
    for (const f of files) {
        if (f.startsWith("!")) continue;
        // frontend/dist is built by prepack; a checkout may not have it yet.
        if (f === "frontend/dist") continue;
        assert.ok(existsSync(join(ROOT, f)), `${f} is listed in package.json \`files\` but missing (from ${dirname(f)})`);
    }
});
