"""#637 Slice 2 — pytest harness for claude-loop integration tests.

Provides three core fixtures :

  - `loop_runner` (factory) : spawn a claude-loop instance with a
    fake-claude probe scenario, wait for the single heartbeat cycle to
    finish (`--once`), return a `LoopHandle` with state-dir path and
    name. Cleanup runs unconditionally at fixture teardown.

  - `inspect_state(name)` : call `claude-loop inspect <name>` and
    return the parsed JSON snapshot — same shape used by humans on
    the command line.

  - `wait_for(predicate, timeout=5.0, interval=0.1)` : poll a sync
    predicate (typically `lambda: inspect_state(name)["foo"] == bar`)
    until it returns truthy or the timeout fires.

Layout : tests are plain `pytest` files under `tests/integration/`.
Run with `cd tests/integration && uv run --with pytest pytest -q` (uv
handles the PEP-723 deps from this conftest's inline-script comment).

Conventions :
  - Each test owns its own state-dir (tmp) and a unique loop name so
    parallel runs don't collide.
  - The harness assumes the dev checkout layout — `bin/claude-loop`
    and `bin/fake-claude` are resolved relative to the repo root via
    walking up from `__file__`.
"""

# /// script
# requires-python = ">=3.10"
# dependencies = ["pytest>=7"]
# ///

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import pytest


# Resolve the dev checkout : conftest is at tests/integration/, the repo
# root is two levels up. `bin/claude-loop` + `bin/fake-claude` live
# there.
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
BIN_CLAUDE_LOOP = REPO_ROOT / "bin" / "claude-loop"
BIN_FAKE_CLAUDE = REPO_ROOT / "bin" / "fake-claude"


@dataclass(frozen=True)
class LoopHandle:
    """Handle to a spawned claude-loop instance.

    `name` is the unique session name used for tmux + state lookup.
    `state_dir` is the absolute path to the loop's state directory.
    `inspect()` returns the parsed JSON snapshot for this loop.
    """

    name: str
    state_dir: Path

    def inspect(self) -> dict:
        return run_inspect(self.name)


def run_inspect(name: str) -> dict:
    """Call `claude-loop inspect <name>` and parse JSON. Raises a
    RuntimeError with the stderr if the binary fails — tests usually
    want a clear assertion, not a silent empty dict."""
    res = subprocess.run(
        [str(BIN_CLAUDE_LOOP), "inspect", name],
        capture_output=True,
        text=True,
        timeout=10,
    )
    if res.returncode != 0:
        raise RuntimeError(
            f"claude-loop inspect {name} failed (rc={res.returncode}): {res.stderr.strip()}"
        )
    return json.loads(res.stdout)


def cleanup_loop(name: str, state_dir: Path) -> None:
    """Best-effort cleanup : kill the tmux session, remove the state-
    dir. Both steps swallow errors — teardown should never raise from
    a teardown helper."""
    # `claude-loop rm` does both in one ; fall back to manual tmux +
    # rmtree if the binary errors (e.g., session already gone).
    try:
        subprocess.run(
            [str(BIN_CLAUDE_LOOP), "rm", name],
            capture_output=True,
            timeout=5,
        )
    except Exception:
        pass
    try:
        subprocess.run(
            ["tmux", "kill-session", "-t", f"cl-{name}"],
            capture_output=True,
            timeout=2,
        )
    except Exception:
        pass
    if state_dir.exists():
        shutil.rmtree(state_dir, ignore_errors=True)


@pytest.fixture
def loop_runner(tmp_path: Path) -> Callable[..., LoopHandle]:
    """Factory fixture : `loop_runner(scenario="picker-2-sessions")`
    spawns a claude-loop with the named fake-claude probe scenario,
    runs ONE heartbeat cycle, returns the handle once the loop exits.
    Cleanup runs at fixture teardown for every handle produced.
    """
    handles: list[LoopHandle] = []

    def _run(scenario: str = "prompt-ready", timeout_s: float = 20.0) -> LoopHandle:
        name = f"cl-test-{uuid.uuid4().hex[:8]}"
        state_dir = tmp_path / name
        state_dir.mkdir(parents=True, exist_ok=True)
        # Run the loop with --once : timer exits after 1 heartbeat
        # cycle. Spawn fake-claude with the probe-mode flag as the
        # claude command. check-cmd `false` = no work to drain (idle).
        env = os.environ.copy()
        env["CL_STATE_DIR"] = str(state_dir)
        # CL_CLAUDE_CMD swaps the claude binary at spawn time
        # (cli.ts:811-819) — feed it fake-claude in probe mode so the
        # tmux pane shows the deterministic scenario instead of a real
        # claude session.
        env["CL_CLAUDE_CMD"] = f"{BIN_FAKE_CLAUDE} --probe-mode {scenario}"
        cmd = [
            str(BIN_CLAUDE_LOOP), "start", name,
            "--once",
            "--check-cmd", "false",
            "--no-wait",
            "--no-attach",
        ]
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env=env,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"claude-loop start failed (rc={proc.returncode}): "
                f"stdout={proc.stdout.strip()} stderr={proc.stderr.strip()}"
            )
        handle = LoopHandle(name=name, state_dir=state_dir)
        handles.append(handle)
        return handle

    yield _run
    for h in handles:
        cleanup_loop(h.name, h.state_dir)


@pytest.fixture
def wait_for() -> Callable[..., bool]:
    """Sync poll : `wait_for(lambda: <truthy>, timeout=5.0, interval=0.1)`.
    Returns True if the predicate eventually fires, False on timeout
    (the test asserts on the return value)."""

    def _wait(
        predicate: Callable[[], bool],
        timeout: float = 5.0,
        interval: float = 0.1,
    ) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                if predicate():
                    return True
            except Exception:
                # Predicate errors during boot are normal (inspect may
                # fail until the loop publishes its first snapshot).
                pass
            time.sleep(interval)
        return False

    return _wait
