/**
 * #3240 — the `cl-session-host` a test drives: `CL_SESSION_HOST_BIN`, else the
 * checkout's own build. Without one, a test is skipped and says how to build
 * it — except where the run requires it (`AIBALL_TEST_REQUIRE_HOST=1`, the
 * Docker image, which builds it): there a missing host is a failure, never a
 * silent skip, so a profile cannot pass on tests it did not run.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Points `CL_SESSION_HOST_BIN` at the host to use; the skip reason, or false. Throws when the host is required and missing. */
export function sessionHostSkip(): string | false {
    const built = ["release", "debug"]
        .map((b) => resolve(import.meta.dirname, "..", "..", "windows", "cl-pty-proxy", "target", b, "cl-session-host"))
        .find(existsSync);
    process.env.CL_SESSION_HOST_BIN = process.env.CL_SESSION_HOST_BIN || built || "";
    if (existsSync(process.env.CL_SESSION_HOST_BIN)) return false;
    const reason = `no cl-session-host at '${process.env.CL_SESSION_HOST_BIN}' (cargo build --release --manifest-path windows/cl-pty-proxy/Cargo.toml)`;
    if (process.env.AIBALL_TEST_REQUIRE_HOST === "1") throw new Error(`${reason} — required in this run (AIBALL_TEST_REQUIRE_HOST=1)`);
    return reason;
}
