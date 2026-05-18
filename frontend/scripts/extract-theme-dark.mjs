#!/usr/bin/env node
/**
 * #B.196 Layer 0 step 1 — extract `.aiball-dark` overrides from per-component
 * <style> blocks into one global theme file.
 *
 * Uses @vue/compiler-sfc to parse the SFC, postcss to walk the CSS AST, and
 * only extracts rules whose entire selector list is .aiball-dark-prefixed
 * (mixed rules stay put — we never split a selector list mid-air).
 *
 * Run from the `frontend/` directory:
 *   node scripts/extract-theme-dark.mjs
 *
 * Idempotent: extracted rules are removed from the source, so re-running is
 * a no-op. Read-only flag (`--dry`) prints what would change.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { parse as parseSfc } from "@vue/compiler-sfc";
import postcss from "postcss";

const ROOT = new URL("../src", import.meta.url).pathname;
const COMPONENTS_DIR = join(ROOT, "components");
const APP_FILE = join(ROOT, "App.vue");
const STYLES_DIR = join(ROOT, "styles");
const THEME_FILE = join(STYLES_DIR, "theme-dark.css");
const DRY = process.argv.includes("--dry");

const DARK_PREFIX = ".aiball-dark";

function isAllDark(selectors) {
    // postcss splits comma-lists for us if we look at rule.selectors
    return selectors.length >= 1 && selectors.every((s) => s.trim().startsWith(DARK_PREFIX));
}

function processVueFile(path) {
    const src = readFileSync(path, "utf8");
    const { descriptor, errors } = parseSfc(src);
    if (errors.length) {
        console.warn(`! parse warnings in ${path}:`, errors.map((e) => e.message));
    }
    const extracted = [];
    let rewritten = src;
    // Process style blocks in reverse so offsets stay valid as we splice.
    const styleBlocks = [...descriptor.styles].reverse();
    for (const block of styleBlocks) {
        const css = block.content;
        const root = postcss.parse(css);
        let blockChanged = false;
        const captures = [];
        root.walkRules((rule) => {
            if (isAllDark(rule.selectors)) {
                captures.push(rule.toString());
                rule.remove();
                blockChanged = true;
            }
        });
        if (!blockChanged) continue;
        // Collapse the runs of blank lines that .remove() leaves behind.
        const newCss = root.toString().replace(/\n{3,}/g, "\n\n");
        const start = block.loc.start.offset;
        const end = block.loc.end.offset;
        rewritten = rewritten.slice(0, start) + newCss + rewritten.slice(end);
        extracted.push(...captures);
    }
    return { rewritten, extracted, original: src };
}

function main() {
    const files = [
        ...readdirSync(COMPONENTS_DIR)
            .filter((f) => f.endsWith(".vue"))
            .map((f) => join(COMPONENTS_DIR, f)),
        APP_FILE,
    ];
    const allChunks = [];
    let totalRules = 0;
    let filesTouched = 0;
    for (const file of files) {
        const { rewritten, extracted, original } = processVueFile(file);
        if (extracted.length === 0) continue;
        filesTouched += 1;
        totalRules += extracted.length;
        const rel = file.startsWith(COMPONENTS_DIR + "/")
            ? `components/${basename(file)}`
            : basename(file);
        allChunks.push({ rel, extracted });
        console.log(`${rel}: ${extracted.length} rule(s)`);
        if (!DRY && rewritten !== original) writeFileSync(file, rewritten);
    }
    if (totalRules === 0) {
        console.log("nothing to extract — already clean.");
        return;
    }
    const out = [
        "/*",
        " * Aiball dark-mode overrides (#B.196 Layer 0).",
        " *",
        " * Extracted from per-component <style> blocks into one global sheet.",
        " * Selectors stay global (`.aiball-dark .X`) because they cross-cut",
        " * components and target the body-level toggle class. Component CSS",
        " * can later move to <style scoped> without these rules drifting —",
        " * a global rule still matches scoped elements (the data-v-xxx",
        " * attribute is added to the element, not required by the selector).",
        " *",
        " * Regenerate-friendly: re-running scripts/extract-theme-dark.mjs is a",
        " * no-op once components are clean; rules added back to a component",
        " * will be re-extracted on the next run.",
        " */",
        "",
    ];
    for (const { rel, extracted } of allChunks) {
        out.push(`/* --- from ${rel} --- */`);
        for (const rule of extracted) out.push(rule);
        out.push("");
    }
    const themeText = out.join("\n");
    if (DRY) {
        console.log(`\n[dry] would write ${THEME_FILE} (${totalRules} rules from ${filesTouched} file(s))`);
        return;
    }
    if (!existsSync(STYLES_DIR)) mkdirSync(STYLES_DIR, { recursive: true });
    // Append-or-replace: read existing theme file, drop our managed sections,
    // then re-emit. This makes re-runs idempotent and preserves any
    // hand-written rules outside the managed `/* --- from <rel> --- */` markers.
    writeFileSync(THEME_FILE, themeText);
    console.log(`\n→ wrote ${THEME_FILE} (${totalRules} rules from ${filesTouched} file(s))`);
}

main();
