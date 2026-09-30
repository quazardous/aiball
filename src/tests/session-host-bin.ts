/**
 * #3240 — the `cl-session-host` a test drives: `CL_SESSION_HOST_BIN`, else the
 * checkout's own build. Without one, a test is skipped and says how to build
 * it — except where the run requires it (`AIBALL_TEST_REQUIRE_HOST=1`, the
 * Docker image, which builds it): there a missing host is a failure, never a
 * silent skip, so a profile cannot pass on tests it did not run.
 */
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

/**
 * #3425 — remove a test's home once its hosts are gone. On Windows a folder
 * that is a live process's current directory (a host started there, the
 * command in it) cannot be removed, and a host exits a moment after
 * `host.shutdown` answers; Node's rmSync does not retry that (EPERM), so this
 * does, for a few seconds.
 */
export async function removeHostHome(dir: string, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    for (;;) {
        try {
            rmSync(dir, { recursive: true, force: true });
            return;
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if ((code !== "EPERM" && code !== "EBUSY") || Date.now() > deadline) throw e;
            await new Promise((r) => setTimeout(r, 100));
        }
    }
}

/** Points `CL_SESSION_HOST_BIN` at the host to use; the skip reason, or false. Throws when the host is required and missing. */
export function sessionHostSkip(): string | false {
    const exe = process.platform === "win32" ? "cl-session-host.exe" : "cl-session-host";
    const built = ["release", "debug"]
        .map((b) => resolve(import.meta.dirname, "..", "..", "windows", "cl-pty-proxy", "target", b, exe))
        .find(existsSync);
    process.env.CL_SESSION_HOST_BIN = process.env.CL_SESSION_HOST_BIN || built || "";
    if (existsSync(process.env.CL_SESSION_HOST_BIN)) return false;
    const reason = `no cl-session-host at '${process.env.CL_SESSION_HOST_BIN}' (cargo build --release --manifest-path windows/cl-pty-proxy/Cargo.toml)`;
    if (process.env.AIBALL_TEST_REQUIRE_HOST === "1") throw new Error(`${reason} — required in this run (AIBALL_TEST_REQUIRE_HOST=1)`);
    return reason;
}
