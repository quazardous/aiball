/**
 * #748 — yaml-scenarios runner. Bridges the existing integration scenario
 * files (`tests/integration/scenarios/*.yaml`, driven by pytest +
 * fake-claude) into the `node:test` unit suite. A scenario file can carry
 * a `unit:` block alongside the existing integration `steps:`, listing
 * pure-function calls + expected outputs. Each entry generates one
 * `node:test` case named after the user story.
 *
 * The point is to keep ONE source of truth per user story. Adding a
 * scenario to a yaml is the single edit that covers both levels — the
 * pytest harness exercises the live loop, the runner here exercises the
 * pure functions. See `docs/SCENARIOS.md` for the full schema +
 * convention.
 *
 * Per-entry yaml shape :
 *   unit:
 *     - name: "human-readable scenario name (= user story)"
 *       call:
 *         module: "./loop-state.js"      # relative to src/claude-loop/
 *         fn:     "computeLoopView"
 *       args: [ {...arg0}, ...arg1, ... ] # positional, spread into fn(...args)
 *       expect:                            # dot-paths against the return
 *         "barWord": "wait"
 *         "afkChunk.prefix": "600s"
 *
 * `expect` values support :
 *   - exact equality for primitives, arrays, objects (deep-equal on the
 *     whole sub-tree if no dot in the key)
 *   - regex literal strings (`"/pattern/"`) for string fields
 *
 * Missing `unit:` block = scenario is integration-only, the runner skips
 * it silently (mirrors the pytest side which skips yamls with no `steps`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = resolve(HERE, "..", "..", "tests", "integration", "scenarios");

interface UnitEntry {
    name: string;
    call: { module: string; fn: string };
    args?: unknown[];
    /** #750 Slice 2 — overrides merged into the scenario's `args_template`
     *  before the call. Lets tests follow the `baseInput(overrides)`
     *  pattern (`loop-state.test.ts` etc.) without re-spelling the full
     *  fixture per entry. The template is shallow-merged ; nested objects
     *  in `args_overrides` REPLACE rather than deep-merge — same semantic
     *  as JavaScript object spread. Ignored when there is no `args_template`. */
    args_overrides?: Record<string, unknown>;
    /** Dot-path assertions against the return value (object returns). */
    expect?: Record<string, unknown>;
    /** #750 Slice 2 — top-level value match for scalar returns
     *  (strings, booleans, numbers). Equality or `"/regex/"` against the
     *  whole return value. Use this instead of `expect` when the
     *  function-under-test doesn't return an object. */
    expect_value?: unknown;
}

interface ScenarioFile {
    scenario?: string;
    /** #750 Slice 2 — when set, every `unit` entry without `args` defaults
     *  to `[args_template + args_overrides]` (single-arg fixture). Halves
     *  the verbosity for large scenarios like `loop-state` (70+ cases all
     *  calling `computeLoopView({...})`). */
    args_template?: Record<string, unknown>;
    unit?: UnitEntry[];
}

/** Walk a dot-path on an arbitrary value. Returns undefined when the path
 *  doesn't resolve — the caller treats that as a real expectation
 *  mismatch (don't allow silent passes on typos). */
function getPath(obj: unknown, path: string): unknown {
    const parts = path.split(".");
    let cur: unknown = obj;
    for (const p of parts) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
}

/** Compare `actual` to `expected`. Strings of shape `"/pattern/flags"`
 *  on the expected side are treated as regex matches against actual. */
function expectMatch(actual: unknown, expected: unknown, label: string): void {
    if (typeof expected === "string" && expected.startsWith("/") && expected.lastIndexOf("/") > 0) {
        // Parse `/pattern/flags`.
        const closing = expected.lastIndexOf("/");
        const pattern = expected.slice(1, closing);
        const flags = expected.slice(closing + 1);
        assert.equal(typeof actual, "string", `${label} expected string for regex match, got ${typeof actual}`);
        const re = new RegExp(pattern, flags);
        assert.match(actual as string, re, `${label} : ${JSON.stringify(actual)} does not match /${pattern}/${flags}`);
        return;
    }
    assert.deepEqual(actual, expected, label);
}

function loadScenarios(): { path: string; data: ScenarioFile }[] {
    let names: string[];
    try {
        names = readdirSync(SCENARIOS_DIR).filter((n) => n.endsWith(".yaml") || n.endsWith(".yml"));
    } catch {
        return [];  // no scenarios dir = no scenarios, not an error
    }
    return names.map((name) => {
        const path = join(SCENARIOS_DIR, name);
        const raw = readFileSync(path, "utf8");
        let data: ScenarioFile = {};
        try { data = (parseYaml(raw) as ScenarioFile) ?? {}; } catch { /* malformed → empty */ }
        return { path, data };
    });
}

const scenarios = loadScenarios();

// Top-level await — node:test supports it. We pre-resolve the modules so
// the test functions stay sync (matches `node:test` ergonomics). Failed
// imports surface as a single fail per scenario rather than crashing the
// whole suite.
const loaded: { entry: UnitEntry; mod: unknown; scenarioName: string; argsTemplate: Record<string, unknown> | null }[] = [];
for (const { path, data } of scenarios) {
    const scenarioName = data.scenario ?? path.split("/").pop() ?? "<unnamed>";
    const argsTemplate = data.args_template ?? null;
    for (const entry of data.unit ?? []) {
        // Resolve the module path relative to src/claude-loop/.
        const modPath = entry.call.module.startsWith(".")
            ? join(HERE, entry.call.module)
            : entry.call.module;
        try {
            const mod = await import(modPath);
            loaded.push({ entry, mod, scenarioName, argsTemplate });
        } catch (e) {
            test(`yaml-scenarios :: ${scenarioName} :: ${entry.name} (load)`, () => {
                assert.fail(`Failed to import ${entry.call.module}: ${(e as Error).message}`);
            });
        }
    }
}

for (const { entry, mod, scenarioName, argsTemplate } of loaded) {
    test(`yaml-scenarios :: ${scenarioName} :: ${entry.name}`, () => {
        const fn = (mod as Record<string, unknown>)[entry.call.fn];
        assert.equal(typeof fn, "function", `Module ${entry.call.module} has no exported function '${entry.call.fn}'`);
        // #750 Slice 2 — resolve args precedence :
        //   explicit `args:` > template + overrides > template alone > `[]`.
        // The template+overrides form is the `baseInput(overrides)` shape
        // for one-arg fixtures.
        let args: unknown[];
        if (entry.args !== undefined) {
            args = entry.args;
        } else if (argsTemplate !== null) {
            args = [{ ...argsTemplate, ...(entry.args_overrides ?? {}) }];
        } else {
            args = [];
        }
        const result = (fn as (...a: unknown[]) => unknown)(...args);
        // #750 Slice 2 — `expect_value` covers scalar returns (string /
        // boolean / number) that the dot-path `expect` can't address.
        // Both may coexist on the same entry.
        if ("expect_value" in entry && entry.expect_value !== undefined) {
            expectMatch(result, entry.expect_value, "expect_value");
        }
        const expect = entry.expect ?? {};
        for (const [key, expected] of Object.entries(expect)) {
            const actual = key.includes(".") ? getPath(result, key) : (result as Record<string, unknown>)[key];
            expectMatch(actual, expected, `expect[${key}]`);
        }
    });
}
