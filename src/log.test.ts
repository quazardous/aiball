// #412 / #944 — level logger. node:test + tsx (zero deps). Run: `npm test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createLogger, type LogRecord, parseLevel, isEnabled, setLevel, currentLevel, DEFAULT_LOG_LEVEL } from "./log.js";
import { _resetLoopConfigCacheForTests } from "./claude-loop/loop-config.js";

afterEach(() => {
    setLevel(null); // reset override
    delete process.env.CL_LOG_LEVEL;
    _resetLoopConfigCacheForTests(); // #689 — loopConfig now caches per-process
});

function capture() {
    const lines: string[] = [];
    return { lines, write: (l: string) => lines.push(l) };
}

function parseLine(line: string): LogRecord {
    assert.ok(line.endsWith("\n"), `line must end with \\n: ${JSON.stringify(line)}`);
    return JSON.parse(line) as LogRecord;
}

test("parseLevel: case-insensitive, null on unknown", () => {
    assert.equal(parseLevel("INFO"), "info");
    assert.equal(parseLevel(" Warning "), "warning");
    assert.equal(parseLevel("emergency"), "emergency");
    assert.equal(parseLevel("loud"), null);
    assert.equal(parseLevel(null), null);
    assert.equal(parseLevel(""), null);
});

test("threshold: default is info; debug dropped, info+ emitted", () => {
    assert.equal(currentLevel(), DEFAULT_LOG_LEVEL);
    const { lines, write } = capture();
    const log = createLogger({ tag: "claude-loop:cl-x", write });
    log.debug("noise");
    log.info("hello");
    log.error("boom");
    assert.equal(lines.length, 2); // debug dropped at default info
    const r0 = parseLine(lines[0]);
    assert.equal(r0.level, "info");
    assert.equal(r0.tag, "claude-loop:cl-x");
    assert.equal(r0.msg, "hello");
    assert.match(r0.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const r1 = parseLine(lines[1]);
    assert.equal(r1.level, "error");
    assert.equal(r1.msg, "boom");
});

test("CL_LOG_LEVEL=debug lets debug through", () => {
    process.env.CL_LOG_LEVEL = "debug";
    const { lines, write } = capture();
    const log = createLogger({ write });
    log.debug("now visible");
    assert.equal(lines.length, 1);
    const r = parseLine(lines[0]);
    assert.equal(r.level, "debug");
    assert.equal(r.msg, "now visible");
    assert.equal(r.tag, undefined); // untagged → omitted from JSON
});

test("CL_LOG_LEVEL=error mutes warning and below", () => {
    process.env.CL_LOG_LEVEL = "error";
    const { lines, write } = capture();
    const log = createLogger({ write });
    log.info("x");
    log.notice("x");
    log.warning("x");
    log.error("kept");
    log.emergency("kept");
    assert.equal(lines.length, 2);
});

test("setLevel override beats env; isEnabled reflects threshold", () => {
    process.env.CL_LOG_LEVEL = "debug";
    setLevel("warning");
    assert.equal(currentLevel(), "warning");
    assert.equal(isEnabled("info"), false);
    assert.equal(isEnabled("warning"), true);
    assert.equal(isEnabled("emergency"), true);
});

test("unknown CL_LOG_LEVEL falls back to default", () => {
    process.env.CL_LOG_LEVEL = "verbose"; // not a level
    assert.equal(currentLevel(), "info");
});

test("log.log(level, msg) routes through the threshold", () => {
    const { lines, write } = capture();
    const log = createLogger({ tag: "t", write });
    log.log("debug", "drop");
    log.log("warning", "keep");
    assert.equal(lines.length, 1);
    const r = parseLine(lines[0]);
    assert.equal(r.level, "warning");
    assert.equal(r.tag, "t");
    assert.equal(r.msg, "keep");
});

test("NDJSON: msg with special chars escapes correctly", () => {
    const { lines, write } = capture();
    const log = createLogger({ tag: "t", write });
    log.info('quote " and newline \n and backslash \\ in msg');
    assert.equal(lines.length, 1);
    const r = parseLine(lines[0]);
    assert.equal(r.msg, 'quote " and newline \n and backslash \\ in msg');
});

test("#1032 replay: emits a record with the EXPLICIT ts (not now), tag preserved", () => {
    const { lines, write } = capture();
    const log = createLogger({ tag: "claude-loop:cl-x", write });
    log.replay("2025-12-31T23:59:59.000Z", "info", "buffered while down");
    assert.equal(lines.length, 1);
    const r = parseLine(lines[0]);
    assert.equal(r.ts, "2025-12-31T23:59:59.000Z", "original ts preserved");
    assert.equal(r.level, "info");
    assert.equal(r.tag, "claude-loop:cl-x");
    assert.equal(r.msg, "buffered while down");
});

test("#1032 replay: still respects the level threshold", () => {
    const { lines, write } = capture();
    const log = createLogger({ write }); // default threshold = info
    log.replay("2025-01-01T00:00:00.000Z", "debug", "dropped");
    assert.equal(lines.length, 0, "debug replay dropped at info threshold");
});
