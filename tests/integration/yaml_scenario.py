"""#638 Slice 1 — YAML scenario parser + validator.

Parses `tests/integration/scenarios/*.yaml` into typed `Scenario`
objects ready for execution by the slice 2 pytest runner. Validates
the structure up-front so a malformed scenario fails fast with a clear
message instead of crashing mid-run.

Scenario shape (per #638 body example) :

  scenario: boot-floor-blocks-hook-early
  steps:
    - spawn: { fake_claude: prompt-ready }
    - at_seconds: 5
      drive: { hook_signal: bootComplete }
    - at_seconds: 10
      expect:
        bar_word: boot
        in_boot_grace: true

Each step is one of :
  - `spawn` — start the loop with a fake-claude probe scenario
  - `drive` — inject an action (hook signal, key, etc.)
  - `expect` — assert on the inspect JSON snapshot (key path → value)

`at_seconds` is the wall-clock offset from spawn ; required on every
step EXCEPT `spawn` (which is always at t=0). Steps are sorted by
at_seconds during execution.
"""

# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml>=6"]
# ///

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


class ScenarioError(ValueError):
    """Raised for any structural problem in a parsed YAML scenario.
    The message carries enough context (scenario name + step index +
    offending key) to pinpoint the issue without re-reading the file."""


@dataclass(frozen=True)
class SpawnStep:
    """The `spawn` step. `fake_claude` is the probe-mode scenario name
    (from `bin/fake-claude --list-probes`). Always implicit t=0."""
    fake_claude: str


@dataclass(frozen=True)
class DriveStep:
    """The `drive` step. `at_seconds` is the wall-clock offset from
    spawn. `action` is the mutation kind (e.g. "hook_signal",
    "send_key") and `payload` carries its arguments as a dict."""
    at_seconds: float
    action: str
    payload: dict


@dataclass(frozen=True)
class ExpectStep:
    """The `expect` step. `at_seconds` is the wall-clock offset.
    `assertions` is a dict mapping inspect-JSON-path → expected value.
    Path syntax is dotted : `pane.compacting`, `view.bar_word`."""
    at_seconds: float
    assertions: dict


Step = SpawnStep | DriveStep | ExpectStep


@dataclass(frozen=True)
class Scenario:
    """A parsed YAML scenario ready for the slice 2 runner. `name` is
    the scenario identifier (declared via `scenario:` key, falls back
    to the file stem if absent). `path` is the original file path
    for diagnostics. `steps` are time-ordered (sorted by at_seconds
    with spawn first). `xfail` is the expected-failure reason string
    when set ; slice 2 runner converts this to `pytest.mark.xfail`."""
    name: str
    path: Path
    steps: tuple[Step, ...] = field(default_factory=tuple)
    xfail: str | None = None


def parse_scenario(path: Path) -> Scenario:
    """Parse a single YAML scenario file. Raises `ScenarioError` on
    any structural problem. Returns a typed `Scenario` with
    time-ordered steps."""
    text = path.read_text()
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise ScenarioError(f"{path}: invalid YAML: {e}") from e
    if doc is None:
        raise ScenarioError(f"{path}: empty YAML document")
    if not isinstance(doc, dict):
        raise ScenarioError(f"{path}: top-level YAML must be a mapping, got {type(doc).__name__}")
    name = str(doc.get("scenario", path.stem))
    raw_xfail = doc.get("xfail")
    if raw_xfail is not None and not isinstance(raw_xfail, str):
        raise ScenarioError(f"{path}: 'xfail' must be a string (reason), got {type(raw_xfail).__name__}")
    xfail = raw_xfail or None  # treat empty string as not-xfail
    raw_steps = doc.get("steps")
    if raw_steps is None or not isinstance(raw_steps, list):
        raise ScenarioError(f"{path}: 'steps' must be a list, got {type(raw_steps).__name__}")
    if not raw_steps:
        raise ScenarioError(f"{path}: 'steps' must not be empty")
    steps: list[Step] = []
    for idx, raw in enumerate(raw_steps):
        if not isinstance(raw, dict):
            raise ScenarioError(f"{path} step[{idx}]: must be a mapping, got {type(raw).__name__}")
        steps.append(_parse_step(path, idx, raw))
    # spawn must be exactly the first step.
    spawn_count = sum(1 for s in steps if isinstance(s, SpawnStep))
    if spawn_count == 0:
        raise ScenarioError(f"{path}: missing 'spawn' step (must be the first step)")
    if spawn_count > 1:
        raise ScenarioError(f"{path}: more than one 'spawn' step (only one allowed, at the top)")
    if not isinstance(steps[0], SpawnStep):
        raise ScenarioError(f"{path}: 'spawn' step must be the FIRST step")
    # Sort timed steps by at_seconds ; spawn stays at index 0.
    timed = sorted(steps[1:], key=lambda s: s.at_seconds)  # type: ignore[union-attr]
    ordered: tuple[Step, ...] = (steps[0], *timed)
    return Scenario(name=name, path=path, steps=ordered, xfail=xfail)


def _parse_step(path: Path, idx: int, raw: dict) -> Step:
    """Parse a single step dict into the appropriate Step variant.
    Validates the shape ; raises ScenarioError on the first issue."""
    keys = set(raw.keys())
    if "spawn" in keys:
        spawn = raw["spawn"]
        if not isinstance(spawn, dict):
            raise ScenarioError(f"{path} step[{idx}].spawn: must be a mapping, got {type(spawn).__name__}")
        fc = spawn.get("fake_claude")
        if not isinstance(fc, str) or not fc:
            raise ScenarioError(f"{path} step[{idx}].spawn.fake_claude: required non-empty string")
        return SpawnStep(fake_claude=fc)
    at = raw.get("at_seconds")
    if not isinstance(at, (int, float)):
        raise ScenarioError(f"{path} step[{idx}].at_seconds: required number on non-spawn steps")
    if at < 0:
        raise ScenarioError(f"{path} step[{idx}].at_seconds: must be >= 0, got {at}")
    if "drive" in keys:
        drive = raw["drive"]
        if not isinstance(drive, dict) or not drive:
            raise ScenarioError(f"{path} step[{idx}].drive: must be a non-empty mapping")
        # The first key is the action name ; everything in the dict is the payload.
        # E.g. `drive: { hook_signal: bootComplete }` → action="hook_signal", payload={"hook_signal": "bootComplete"}.
        action = next(iter(drive))
        return DriveStep(at_seconds=float(at), action=action, payload=dict(drive))
    if "expect" in keys:
        expect = raw["expect"]
        if not isinstance(expect, dict) or not expect:
            raise ScenarioError(f"{path} step[{idx}].expect: must be a non-empty mapping")
        return ExpectStep(at_seconds=float(at), assertions=dict(expect))
    raise ScenarioError(
        f"{path} step[{idx}]: must declare one of 'spawn' / 'drive' / 'expect' "
        f"(got keys: {sorted(keys)})"
    )


def load_scenarios_from_dir(dir_path: Path) -> list[Scenario]:
    """Convenience for the pytest runner : load every `*.yaml` under
    `dir_path`, return the list sorted by scenario name (stable
    ordering across runs). Errors short-circuit — one bad file fails
    the whole load, with the offending path in the message."""
    if not dir_path.is_dir():
        raise ScenarioError(f"{dir_path}: not a directory")
    files = sorted(dir_path.glob("*.yaml"))
    return [parse_scenario(p) for p in files]


def get_inspect_path(snapshot: dict, dotted: str) -> Any:
    """Navigate a dotted path through an inspect JSON snapshot.
    Returns the leaf value, or raises `KeyError` with the path that
    didn't resolve. Used by the slice 2 runner to evaluate
    `ExpectStep.assertions`."""
    cur: Any = snapshot
    parts = dotted.split(".")
    seen: list[str] = []
    for part in parts:
        seen.append(part)
        if not isinstance(cur, dict):
            raise KeyError(f"{'.'.join(seen)}: parent is not a mapping ({type(cur).__name__})")
        if part not in cur:
            raise KeyError(f"{'.'.join(seen)}: missing key")
        cur = cur[part]
    return cur
