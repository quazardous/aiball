"""#638 Slice 2 — pytest runner that iterates the yaml scenarios.

Loads every `tests/integration/scenarios/*.yaml`, parametrizes one
test per scenario. For each ExpectStep, spawns a fresh loop with
`interval_s=at_seconds` so the heartbeat lands at the right moment,
then asserts the inspect snapshot against the expectations via the
dotted-path lookup from slice 1.

MVP scope (slice 2) :
  - `SpawnStep` : honored via the harness `loop_runner(fake_claude=…)`.
  - `ExpectStep` : asserted via `get_inspect_path` ; multiple expect
    steps with different `at_seconds` run each in its OWN fresh loop
    spawn (slow but simple — each spawn boots from scratch).
  - `DriveStep` : WARNED + skipped today. Slice 2b will wire the
    driver (likely via a spawn_async path that holds the loop in
    background while drives apply at the right wall-clock).

Run :
  cd tests/integration
  uv run --with pytest --with pyyaml pytest test_yaml_scenarios.py -v
"""

from __future__ import annotations

import sys
import warnings
from pathlib import Path

import pytest

# Ensure the test's own dir is on sys.path for the `yaml_scenario` import.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from yaml_scenario import (  # noqa: E402
    DriveStep,
    ExpectStep,
    Scenario,
    SpawnStep,
    get_inspect_path,
    load_scenarios_from_dir,
)


SCENARIOS_DIR = Path(__file__).resolve().parent / "scenarios"


def _scenario_id(sc: Scenario) -> str:
    """Pytest param id : scenario.name (so failures point at the
    scenario file, not the parametrize index)."""
    return sc.name


def _load_all() -> list[Scenario]:
    """Wrap load_scenarios_from_dir : empty dir returns []."""
    if not SCENARIOS_DIR.is_dir():
        return []
    return load_scenarios_from_dir(SCENARIOS_DIR)


SCENARIOS = _load_all()


def _scenario_params() -> list:
    """Build pytest.param entries with per-scenario marks. A scenario
    carrying `xfail: "reason"` gets `pytest.mark.xfail(strict=False)`
    so the runner accepts known-fragile cases without poisoning the
    suite."""
    params = []
    for sc in SCENARIOS:
        marks = []
        if sc.xfail:
            marks.append(pytest.mark.xfail(reason=sc.xfail, strict=False))
        params.append(pytest.param(sc, marks=marks, id=_scenario_id(sc)))
    return params


@pytest.mark.skipif(not SCENARIOS, reason="no yaml scenarios under tests/integration/scenarios/")
@pytest.mark.parametrize("scenario", _scenario_params())
def test_yaml_scenario(scenario: Scenario, loop_runner):
    """Execute one scenario : every ExpectStep spawns a fresh loop
    with `interval_s = at_seconds` so the single heartbeat lands at
    the right moment, then asserts the inspect snapshot.

    DriveSteps are no-op'd with a warning (slice 2b territory)."""
    spawn = scenario.steps[0]
    assert isinstance(spawn, SpawnStep), f"{scenario.path}: parser invariant — spawn must be first"

    for step in scenario.steps[1:]:
        if isinstance(step, DriveStep):
            warnings.warn(
                f"{scenario.path}: DriveStep at t={step.at_seconds} skipped (slice 2b)",
                stacklevel=2,
            )
            continue
        assert isinstance(step, ExpectStep), f"{scenario.path}: unknown step type {type(step).__name__}"
        # Each expect → its own loop spawn. interval_s=ceil(at_seconds)
        # so the heartbeat fires at or just after the expected wall-clock.
        # Bumped by 1s when the requested at_seconds is 0 (the loop
        # needs at least 1s heartbeat interval).
        interval = max(1, int(step.at_seconds) + 1)
        handle = loop_runner(scenario=spawn.fake_claude, interval_s=interval)
        state = handle.inspect()
        # Assert each expectation, accumulate failures so the test
        # reports ALL mismatches at once instead of stopping at the first.
        failures: list[str] = []
        for path, expected in step.assertions.items():
            try:
                actual = get_inspect_path(state, path)
            except KeyError as e:
                failures.append(f"  - {path}: KeyError {e}")
                continue
            if actual != expected:
                failures.append(f"  - {path}: expected {expected!r}, got {actual!r}")
        for path, should_exist in step.existence.items():
            try:
                get_inspect_path(state, path)
                exists = True
            except KeyError:
                exists = False
            if exists is not should_exist:
                want = "present" if should_exist else "absent"
                got = "present" if exists else "absent"
                failures.append(f"  - {path}: expected {want}, got {got}")
        if failures:
            pytest.fail(
                f"{scenario.path} expect@t={step.at_seconds}s :\n" + "\n".join(failures)
                + f"\nstate snapshot: {state!r}"
            )
