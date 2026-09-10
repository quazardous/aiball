/**
 * #2180 — run `init` as if it had been launched from `cwd`.
 *
 * bootstrap resolves its directory with `userCwd()` = `AIBALL_CWD ?? process.cwd()`.
 * A chdir alone is not enough: a shell started from inside a loop exports
 * `AIBALL_CWD` (the loop's own repo), and that wins. `claude-loop start --init
 * --cwd X` run from such a shell wrote into the loop's repo instead of X — it
 * rewrote the live aiball checkout's identity during a test. Both are pointed at
 * `cwd` for the duration, then restored, whatever `fn` does.
 */
export async function withInitCwd<T>(cwd: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!cwd) return fn();
    const origCwd = process.cwd();
    const hadEnv = Object.prototype.hasOwnProperty.call(process.env, "AIBALL_CWD");
    const origEnv = process.env.AIBALL_CWD;
    process.chdir(cwd);
    process.env.AIBALL_CWD = cwd;
    try {
        return await fn();
    } finally {
        process.chdir(origCwd);
        if (hadEnv) process.env.AIBALL_CWD = origEnv;
        else delete process.env.AIBALL_CWD;
    }
}
