//! Bake the aiball version into the binary, so `cl-pty-proxy --version` says
//! which aiball it was built from.
//!
//! The crate's own version (`CARGO_PKG_VERSION`) cannot do this: it has never
//! been bumped, so it prints the same string before and after a contract change.
//! The repo-root `package.json` is the project's single source of truth, and
//! reading it here stamps EVERY build — the one `install.ps1` / `install.sh`
//! compiles on the machine as well as the release artifacts — with no release
//! step to remember.
//!
//! No build-dependency on a JSON parser: the top-level `"version"` is the first
//! `"version"` key in `package.json`, and a failed read degrades to `unknown`,
//! which the machine check reports as "cannot be verified" rather than as a match.

use std::{env, fs, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    // windows/cl-pty-proxy → repo root
    let pkg = manifest.join("..").join("..").join("package.json");
    println!("cargo:rerun-if-changed={}", pkg.display());

    let version = fs::read_to_string(&pkg)
        .ok()
        .and_then(|s| first_version(&s))
        .unwrap_or_else(|| {
            println!("cargo:warning=could not read the aiball version from {}", pkg.display());
            "unknown".to_string()
        });
    println!("cargo:rustc-env=AIBALL_VERSION={version}");
}

/// The value of the first `"version": "<value>"` pair.
fn first_version(json: &str) -> Option<String> {
    let after_key = &json[json.find("\"version\"")? + "\"version\"".len()..];
    let after_colon = after_key.trim_start().strip_prefix(':')?.trim_start();
    let body = after_colon.strip_prefix('"')?;
    let value = &body[..body.find('"')?];
    (!value.is_empty()).then(|| value.to_string())
}
