// #412 — level logger. node:test + tsx (zero deps). Run: `npm test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createLogger, parseLevel, isEnabled, setLevel, currentLevel, DEFAULT_LOG_LEVEL } from "./log.js";

afterEach(() => {
    setLevel(null); // reset override
    delete process.env.CL_LOG_LEVEL;
});

function capture() {
    const lines: string[] = [];
    return { lines, write: (l: string) => lines.push(l) };
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
    assert.match(lines[0], /^\S+ \[claude-loop:cl-x\] INFO hello\n$/);
    assert.match(lines[1], /^\S+ \[claude-loop:cl-x\] ERROR boom\n$/);
});

test("CL_LOG_LEVEL=debug lets debug through", () => {
    process.env.CL_LOG_LEVEL = "debug";
    const { lines, write } = capture();
    const log = createLogger({ write });
    log.debug("now visible");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\S+ DEBUG now visible\n$/); // no tag → no [..]
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
    assert.match(lines[0], /\[t\] WARNING keep\n$/);
});
