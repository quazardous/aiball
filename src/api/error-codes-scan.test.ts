/**
 * #3039 — every refusal the API writes carries a code: `refuse()` and the
 * helpers put one, and a hand-written `.json({ error })` must name it. This
 * scan finds the hand-written error answers without a `code` in the API's
 * files; there are none, and a new one turns this red:
 * write it with `refuse(res, status, msg, ERROR_CODES.X)`, or add `code:`.
 * (At run time `errorCodeDefaults` still gives it the generic code of its
 * status; this test is about choosing one on purpose.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function apiFiles(): string[] {
    const inApi = readdirSync(join(SRC, "api"))
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => join(SRC, "api", f));
    return [...inApi, join(SRC, "api.ts"), join(SRC, "auth.ts"), join(SRC, "app.ts")];
}

/** Index just past the `)` closing the `(` at `open`, skipping strings, templates and comments. */
function closingParen(s: string, open: number): number {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
        const c = s[i];
        if (c === "/" && s[i + 1] === "/") { i = s.indexOf("\n", i); if (i < 0) return s.length; continue; }
        if (c === "/" && s[i + 1] === "*") { i = s.indexOf("*/", i) + 1; continue; }
        if (c === "'" || c === '"' || c === "`") { i = endOfString(s, i); continue; }
        if (c === "(") depth++;
        else if (c === ")" && --depth === 0) return i + 1;
    }
    return s.length;
}

function endOfString(s: string, start: number): number {
    const q = s[start];
    for (let i = start + 1; i < s.length; i++) {
        if (s[i] === "\\") { i++; continue; }
        if (q === "`" && s[i] === "$" && s[i + 1] === "{") {
            let depth = 1;
            i += 2;
            for (; i < s.length && depth > 0; i++) {
                if (s[i] === "'" || s[i] === '"' || s[i] === "`") { i = endOfString(s, i); continue; }
                if (s[i] === "{") depth++;
                else if (s[i] === "}") depth--;
            }
            i--;
            continue;
        }
        if (s[i] === q) return i;
    }
    return s.length;
}

/** The hand-written error answers without a code in `source`, as their first line. */
export function uncodedRefusals(source: string): string[] {
    const found: string[] = [];
    for (let at = source.indexOf(".json("); at >= 0; at = source.indexOf(".json(", at + 1)) {
        const open = at + ".json".length;
        const arg = source.slice(open + 1, closingParen(source, open) - 1).trim();
        if (!arg.startsWith("{")) continue;
        if (!/(^\{|,)\s*error\s*[:,}]/.test(arg)) continue;
        if (/(^\{|,)\s*code\s*[:,}]/.test(arg)) continue;
        found.push(source.slice(source.lastIndexOf("\n", at) + 1, source.indexOf("\n", at)).trim());
    }
    return found;
}

test("the scan sees a refusal without a code, and not one with a code", () => {
    assert.equal(uncodedRefusals(`res.status(403).json({ error: "no" });`).length, 1);
    assert.equal(uncodedRefusals(`res.status(403).json({\n  error: \`a (b) \${x}\`,\n  hint: "c",\n});`).length, 1);
    assert.equal(uncodedRefusals(`res.status(403).json({ error: "no", code: ERROR_CODES.FORBIDDEN });`).length, 0);
    assert.equal(uncodedRefusals(`res.json({ ok: true, errors: [] });`).length, 0);
});

test("no refusal in the API is written without a code", () => {
    const lines: string[] = [];
    for (const file of apiFiles()) {
        lines.push(...uncodedRefusals(readFileSync(file, "utf8")).map((l) => `${relative(SRC, file)}: ${l}`));
    }
    assert.deepEqual(lines, [], `refusals without a code:\n${lines.join("\n")}`);
});
