// #991 — volatile env.local. The loop sources `env` then `env.local` (if
// present) on every (re)spawn, so shell-prefix CL_* overrides apply for the
// session without persisting into `env`. This asserts the runtime CONTRACT of
// the generated bash sourcing snippet (precedence + missing-file guard + the
// "clean" truncation semantic) — the exact form used in cli.ts/manage.ts spawns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sq(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}
// the snippet cli.ts/manage.ts emit before exec-ing the timer / claude
function sourceSnippet(env: string, envLocal: string, tail: string): string {
    return `source ${sq(env)}; [ -f ${sq(envLocal)} ] && source ${sq(envLocal)}; ${tail}`;
}
function run(env: string, envLocal: string): { out: string; code: number } {
    const r = spawnSync("bash", ["-lc", sourceSnippet(env, envLocal, 'printf "%s" "${CL_CAPTURE:-<unset>}"')], { encoding: "utf8" });
    return { out: r.stdout ?? "", code: r.status ?? -1 };
}

test("env.local wins over env (volatile override precedence)", () => {
    const sd = mkdtempSync(join(tmpdir(), "envlocal-991-"));
    const env = join(sd, "env");
    const local = join(sd, "env.local");
    writeFileSync(env, "export CL_CAPTURE=base\n");
    writeFileSync(local, "export CL_CAPTURE=1\n");
    const r = run(env, local);
    assert.equal(r.code, 0);
    assert.equal(r.out, "1", "env.local sourced after env must win");
    rmSync(sd, { recursive: true, force: true });
});

test("missing env.local does not break the spawn", () => {
    const sd = mkdtempSync(join(tmpdir(), "envlocal-991b-"));
    const env = join(sd, "env");
    writeFileSync(env, "export CL_CAPTURE=base\n");
    const r = run(env, join(sd, "env.local")); // env.local absent
    assert.equal(r.code, 0, "the `[ -f ] &&` guard must keep exit 0 when absent");
    assert.equal(r.out, "base");
    rmSync(sd, { recursive: true, force: true });
});

test("empty (re-seeded) env.local + template env without override → clean/unset", () => {
    // The #991 "plain start re-seeds env.local empty" semantic: env is the
    // template (no shell override), env.local truncated empty → CL_CAPTURE off.
    const sd = mkdtempSync(join(tmpdir(), "envlocal-991c-"));
    const env = join(sd, "env");
    const local = join(sd, "env.local");
    writeFileSync(env, "export MUX_CMD=tmux\n"); // template, no CL_CAPTURE
    writeFileSync(local, ""); // truncated by a fresh cold start
    const r = run(env, local);
    assert.equal(r.code, 0);
    assert.equal(r.out, "<unset>", "a clean start must not carry a stale volatile override");
    rmSync(sd, { recursive: true, force: true });
});
