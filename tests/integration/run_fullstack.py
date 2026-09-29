#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml>=6"]
# ///
"""#984 (#981 Slice 3) — full-stack scenario orchestrator.

Runs ONE scenario against the real containerised stack (tests/docker-compose):
the `daemon` service (real aiball) + the `agent` service (real claude-loop +
PTY proxy + hooks driving fake-claude — the only faked component). It plays the
scenario's chronological multi-target steps on a single wall-clock and asserts
across layers.

Usage:
    tests/integration/run_fullstack.py <scenario.yaml> [--only target,target]
    AIBALL_TEST_PORT=17911 tests/integration/run_fullstack.py scenarios/x.yaml

Step targets handled:
    spawn          — compose up (the agent autostarts the loop with the
                     scenario's `fake_claude`).
    human          — tmux send-keys into the agent pane (proxy sees a human
                     keystroke). `type: "..."` (literal) / `key: F9` (named key).
    expect.inspect — assert on `claude-loop inspect` (the loop snapshot).

NOT yet wired (loudly SKIPPED, never silently — #984 next layer):
    fixture, aiball:* mutations, expect.daemon — need the daemon DB/API seed +
    query helpers. Skipped steps are reported and make the run INCOMPLETE
    (non-zero exit) so a scenario relying on them is never a false green.
"""
from __future__ import annotations

import argparse
import os
import json
import subprocess
import sys
import time
_T0 = time.monotonic()
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from yaml_scenario import (  # noqa: E402
    AiballStep,
    ExpectStep,
    HumanStep,
    SpawnStep,
    DriveStep,
    filter_scenario_by_targets,
    get_inspect_path,
    parse_scenario,
)

REPO = Path(__file__).resolve().parents[2]
COMPOSE = REPO / "tests" / "docker-compose.yml"


def _compose(*args: str, env: dict | None = None, capture: bool = False) -> subprocess.CompletedProcess:
    cmd = ["docker", "compose", "-f", str(COMPOSE)]
    # #3380 — the run's shared node_modules volumes, when run-docker.sh made them.
    if os.environ.get("AIBALL_TEST_NM"):
        cmd += ["-f", str(REPO / "tests" / "docker-compose.nm.yml")]
        net = f"{os.environ.get('COMPOSE_PROJECT_NAME', 'tests')}-net"
        os.environ["AIBALL_TEST_NET"] = net
        if env is not None:
            env = {**env, "AIBALL_TEST_NET": net}
        if subprocess.run(["docker", "network", "inspect", net], capture_output=True).returncode != 0:
            subprocess.run(["docker", "network", "create", net], capture_output=True)
    cmd += list(args)
    return subprocess.run(cmd, env=env, text=True, capture_output=capture)


def _agent_exec(name_args: list[str], capture: bool = True) -> subprocess.CompletedProcess:
    return _compose("exec", "-T", "agent", *name_args, capture=capture)


def _wait_loop_ready(loop_name: str, timeout_s: float = 90.0) -> dict:
    """Poll `claude-loop inspect` until it reports exists:true (+ a running
    timer). Returns the last inspect snapshot. Raises on timeout."""
    deadline = time.monotonic() + timeout_s
    last: dict = {}
    while time.monotonic() < deadline:
        r = _agent_exec(["/app/bin/claude-loop", "inspect", loop_name])
        if r.returncode == 0 and r.stdout.strip():
            try:
                last = json.loads(r.stdout)
            except json.JSONDecodeError:
                last = {}
            if last.get("exists") and last.get("runtime", {}).get("timer", {}).get("alive"):
                return last
        time.sleep(2)
    raise TimeoutError(f"loop '{loop_name}' not ready after {timeout_s}s (last: {last})")


def _inspect(loop_name: str) -> dict:
    r = _agent_exec(["/app/bin/claude-loop", "inspect", loop_name])
    if r.returncode != 0:
        raise RuntimeError(f"inspect failed: {r.stderr.strip()}")
    return json.loads(r.stdout)


def _send_keys(loop_name: str, args: list[str]) -> None:
    _agent_exec(["tmux", "send-keys", "-t", f"{loop_name}.0", *args], capture=True)


# #3066 — a host-mode scenario: the session host is the daemon's, on the
# daemon's machine, so the agent container runs its own daemon (its state in
# /agent-daemon) and the loop talks to it; this is where it is driven.
HOST_MODE = {"on": False}


def _daemon_ctl(*args: str) -> object:
    """Run tests/daemon-ctl.ts next to the daemon the loop talks to ; parse its JSON line."""
    if HOST_MODE["on"]:
        r = _compose("exec", "-T", "-e", "AIBALL_HOME=/agent-daemon", "-e", "AIBALL_SOCK=", "agent",
                     "npx", "tsx", "/app/tests/daemon-ctl.ts", *args, capture=True)
    else:
        r = _compose("exec", "-T", "daemon", "npx", "tsx", "/app/tests/daemon-ctl.ts", *args, capture=True)
    if r.returncode != 0:
        raise RuntimeError(f"daemon-ctl {args} failed: {r.stderr.strip() or r.stdout.strip()}")
    return json.loads(r.stdout.strip()) if r.stdout.strip() else None


def _wait_daemon_ready(timeout_s: float = 60.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        r = _compose("exec", "-T", "daemon", "node", "-e",
                     "fetch('http://127.0.0.1:7777/api/health').then(x=>process.exit(x.ok?0:1)).catch(()=>process.exit(1))",
                     capture=True)
        if r.returncode == 0:
            return
        time.sleep(2)
    raise TimeoutError(f"daemon not ready after {timeout_s}s")


def _dump_loop(loop_name: str, lines: int = 80) -> None:
    """The loop's inspect snapshot and the tail of its log, for a failed run."""
    r = _agent_exec(["/app/bin/claude-loop", "inspect", loop_name])
    print(f"[fullstack +{time.monotonic() - _T0:.0f}s] inspect {loop_name}: {r.stdout.strip() or r.stderr.strip()}")
    log = _agent_exec(["sh", "-c", f"tail -n {lines} \"$HOME/.claude-loop/{loop_name}/loop.log\""])
    print(f"[fullstack +{time.monotonic() - _T0:.0f}s] loop.log (last {lines} lines):\n{log.stdout or log.stderr}")


def _wait_agent_daemon_ready(timeout_s: float = 90.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        r = _agent_exec(["curl", "-sf", "-o", "/dev/null", "http://127.0.0.1:7777/api/health"])
        if r.returncode == 0:
            return
        time.sleep(2)
    raise TimeoutError(f"the agent's daemon not ready after {timeout_s}s")


def _resolve(value: object, handles: dict) -> object:
    """Substitute `@name` references with the fixture handle ids. Recurses
    into dicts/lists ; a bare `@name` string → handles[name]."""
    if isinstance(value, str) and value.startswith("@"):
        key = value[1:]
        if key not in handles:
            raise KeyError(f"unknown fixture handle '@{key}' (have: {sorted(handles)})")
        return handles[key]
    if isinstance(value, dict):
        return {k: _resolve(v, handles) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve(v, handles) for v in value]
    return value


def _resolve_path(path: str, handles: dict) -> str:
    """Substitute `@name` tokens inside a dotted query path (e.g.
    `ticket.@ticket.ping_rows` → `ticket.42.ping_rows`)."""
    return ".".join(
        str(handles[p[1:]]) if p.startswith("@") else p
        for p in path.split(".")
    )


def _eval_expect(step: ExpectStep, snapshot: dict) -> list[str]:
    """Return a list of failure strings (empty = all assertions passed)."""
    fails: list[str] = []
    for path, want in step.assertions.items():
        try:
            got = get_inspect_path(snapshot, path)
        except KeyError as e:
            fails.append(f"{path}: missing ({e})")
            continue
        if got != want:
            fails.append(f"{path}: want {want!r}, got {got!r}")
    for path, must_exist in step.existence.items():
        try:
            get_inspect_path(snapshot, path)
            present = True
        except KeyError:
            present = False
        if present != must_exist:
            fails.append(f"{path}: present={present}, expected present={must_exist}")
    return fails


def _expect_once(step: ExpectStep, loop_name: str, handles: dict) -> list[str] | None:
    """One look at an expectation: its failures, [] when it holds, None for a target not wired."""
    if step.assert_target == "inspect":
        return _eval_expect(step, _inspect(loop_name))
    if step.assert_target == "daemon":
        fails = []
        for path, want in step.assertions.items():
            got = _daemon_ctl("query", _resolve_path(path, handles))
            if got != want:
                fails.append(f"{path}: want {want!r}, got {got!r}")
        return fails
    return None


def _expect_by(step: ExpectStep, deadline: float, loop_name: str, handles: dict) -> list[str] | None:
    """#3380 — look every second until the expectation holds or `deadline` passes.
    A scenario's expectations are states that stay once reached (a ping read, a
    wake delivered), so passing early means the same as passing at `at`."""
    while True:
        fails = _expect_once(step, loop_name, handles)
        if not fails or time.monotonic() >= deadline:
            return fails
        time.sleep(1)


def run(scenario_path: Path, only: set[str] | None, keep: bool = False) -> int:
    sc = parse_scenario(scenario_path)
    if only is not None:
        sc = filter_scenario_by_targets(sc, only)
    spawn = sc.steps[0]
    if not isinstance(spawn, SpawnStep):
        print(f"FATAL: first step must be spawn, got {type(spawn).__name__}", file=sys.stderr)
        return 2

    loop_name = "agent1"
    import os
    env = {**os.environ, "AGENT_SCENARIO": spawn.fake_claude, "AGENT_NAME": loop_name}
    HOST_MODE["on"] = spawn.host
    if spawn.host:
        env["AGENT_HOST"] = "1"

    passed = failed = skipped = 0
    handles: dict = {}
    print(f"[fullstack +{time.monotonic() - _T0:.0f}s] scenario={sc.name} fake_claude={spawn.fake_claude} fixture={sc.fixture}")

    # Bring up the daemon FIRST and seed the fixture BEFORE the agent starts —
    # the loop drains its unread/actionable at boot, so the seed must already be
    # in the daemon when the loop wakes (else the startup wake finds nothing and
    # the WakeMachine gates further wakes). #985.
    print(f"[fullstack +{time.monotonic() - _T0:.0f}s] compose up -d daemon ...")
    up = _compose("up", "-d", "daemon", env=env, capture=True)
    if up.returncode != 0:
        print(f"FATAL: compose up daemon failed:\n{up.stderr}", file=sys.stderr)
        _compose("down", "-v", env=env)
        return 2

    try:
        _wait_daemon_ready()
        if sc.fixture and not spawn.host:
            handles = _daemon_ctl("seed", sc.fixture) or {}
            print(f"[fullstack +{time.monotonic() - _T0:.0f}s] seeded fixture '{sc.fixture}' → handles {handles}")
        print(f"[fullstack +{time.monotonic() - _T0:.0f}s] compose up -d agent ...")
        # --build: the agent image carries built binaries (the proxy, the host);
        # an image cached from before a Dockerfile change would lack them.
        # #3380 — AIBALL_TEST_PREBUILT: built once for the whole run, before the scenarios.
        build = "--no-build" if os.environ.get("AIBALL_TEST_PREBUILT") else "--build"
        up2 = _compose("up", "-d", build, "agent", env=env, capture=True)
        if up2.returncode != 0:
            raise RuntimeError(f"compose up agent failed: {up2.stderr}")
        if spawn.host:
            # The agent's own daemon first, then the seed, then the loop (it waits for `go`).
            _wait_agent_daemon_ready()
            if sc.fixture:
                handles = _daemon_ctl("seed", sc.fixture) or {}
                print(f"[fullstack +{time.monotonic() - _T0:.0f}s] seeded fixture '{sc.fixture}' (agent's daemon) → handles {handles}")
            _agent_exec(["touch", "/agent-daemon/go"])
            print(f"[fullstack +{time.monotonic() - _T0:.0f}s] host mode: the loop starts on the session host")
        _wait_loop_ready(loop_name)
        print(f"[fullstack +{time.monotonic() - _T0:.0f}s] loop ready — playing timeline")
        t0 = time.monotonic()
        for step in sc.steps[1:]:
            at = getattr(step, "at_seconds", 0.0)
            # #3380 — an expectation holds BY its `at`: polled from now until then,
            # it passes as soon as it is true. An action still waits for its `at`.
            if isinstance(step, ExpectStep):
                fails = _expect_by(step, t0 + at, loop_name, handles)
                label = "inspect" if step.assert_target == "inspect" else "daemon"
                if fails is None:
                    print(f"[t={at}] SKIP expect target '{step.assert_target}'")
                    skipped += 1
                elif fails:
                    failed += 1
                    print(f"[t={at}] EXPECT({label}) FAIL: {'; '.join(fails)}")
                else:
                    passed += 1
                    print(f"[t={at}] EXPECT({label}) ok after {time.monotonic() - t0:.0f} s")
                continue
            delay = (t0 + at) - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            if isinstance(step, HumanStep):
                if step.action == "type":
                    _send_keys(loop_name, ["-l", str(step.payload["type"])])
                    print(f"[t={at}] human type {step.payload['type']!r}")
                elif step.action == "key":
                    _send_keys(loop_name, [str(step.payload["key"])])
                    print(f"[t={at}] human key {step.payload['key']!r}")
                else:
                    print(f"[t={at}] SKIP human action '{step.action}' (not wired)")
                    skipped += 1
            elif isinstance(step, AiballStep):
                spec = _resolve({step.action: step.payload[step.action]}, handles)
                _daemon_ctl("mutate", json.dumps(spec))
                print(f"[t={at}] aiball {step.action} {spec[step.action]!r}")
            elif isinstance(step, DriveStep):
                print(f"[t={at}] SKIP drive '{step.action}' — loop-drive not wired in full runner")
                skipped += 1
    except Exception as e:  # noqa: BLE001 — surface any orchestration error
        print(f"FATAL during run: {e}", file=sys.stderr)
        failed += 1
    finally:
        # #3093 — a failure said nothing of why: show what the loop saw before the
        # stack goes, its snapshot and the end of its log.
        if failed:
            _dump_loop(loop_name)
        if keep:
            print(f"[fullstack +{time.monotonic() - _T0:.0f}s] --keep: stack left up (docker compose -f tests/docker-compose.yml down -v)")
        else:
            print(f"[fullstack +{time.monotonic() - _T0:.0f}s] compose down -v ...")
            _compose("down", "-v", env=env, capture=True)

    print(f"[fullstack +{time.monotonic() - _T0:.0f}s] result: {passed} passed, {failed} failed, {skipped} skipped")
    # Non-zero if anything failed OR anything was skipped (incomplete coverage).
    return 0 if (failed == 0 and skipped == 0) else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Full-stack scenario orchestrator (#984)")
    ap.add_argument("scenario", type=Path, help="scenario yaml file")
    ap.add_argument("--only", help="comma-separated targets for partial run (e.g. human,expect_inspect)")
    ap.add_argument("--keep", action="store_true", help="leave the stack up after the run, to look at it")
    args = ap.parse_args()
    only = set(args.only.split(",")) if args.only else None
    return run(args.scenario, only, keep=args.keep)


if __name__ == "__main__":
    sys.exit(main())
