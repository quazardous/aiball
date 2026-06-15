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
class HumanStep:
    """#981 S2 — the `human` step : a human keystroke fed through the PTY
    proxy (= tmux send-keys into the loop pane, which the proxy sees as a
    real human keystroke). `action` is the first key of the mapping
    (`type` / `key` / `detach` / `attach` …) ; `payload` is the full dict.
    E.g. `human: { type: "abc" }` → action="type" ; `human: { key: F9 }`."""
    at_seconds: float
    action: str
    payload: dict


@dataclass(frozen=True)
class AiballStep:
    """#981 S2 — the `aiball` step : a data-plane mutation on the daemon
    DURING the run (ticket_new / ticket_reply / accept_decision …), via
    the API/MCP. The INITIAL data set is the scenario-level `fixture:`
    (seeded before t=0) ; this is for mid-scenario changes. `action` is
    the first key of the mapping ; `payload` is the full dict."""
    at_seconds: float
    action: str
    payload: dict


@dataclass(frozen=True)
class ExpectStep:
    """The `expect` step. `at_seconds` is the wall-clock offset.

    `assert_target` (#981 S2) routes the assertion to a layer :
      - `inspect` (default) : assert on the `claude-loop inspect` JSON.
      - `daemon`  : assert on the daemon state (ticket status, ping rows,
        SSE …) via the API. Selected by wrapping the body in
        `expect: { daemon: {...} }` ; bare keys (or `inspect: {...}`) stay
        on the loop snapshot (back-compat with #638 scenarios).

    Two assertion families coexist on the same step :
      - `assertions` : dotted-path → expected value (equality check).
      - `existence`  : dotted-path → bool. True = path MUST exist (any
        value), False = path must NOT exist. Used for value-less presence
        checks (`pane: { present: true }` or top-level `exists: [...]`).
    Path syntax is dotted : `pane.compacting`, `view.bar_word`."""
    at_seconds: float
    assertions: dict
    existence: dict = field(default_factory=dict)
    assert_target: str = "inspect"


Step = SpawnStep | DriveStep | HumanStep | AiballStep | ExpectStep


# #981 S2 — per-step target tag, used by `filter_scenario_by_targets` for
# partial execution (run a scenario for just one runner). `spawn` is infra
# and always kept. `expect` splits by its assertion layer.
def step_target(step: Step) -> str:
    if isinstance(step, SpawnStep):
        return "spawn"
    if isinstance(step, DriveStep):
        return "loop"
    if isinstance(step, HumanStep):
        return "human"
    if isinstance(step, AiballStep):
        return "aiball"
    if isinstance(step, ExpectStep):
        return f"expect_{step.assert_target}"
    raise ScenarioError(f"unknown step type {type(step).__name__}")


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
    # #981 S2 — name of the aiball data fixture seeded into the daemon
    # BEFORE t=0 (timeline 3 initial state). None = no seed. The full
    # runner resolves it ; the fake-claude-viz / loop-only runners ignore it.
    fixture: str | None = None


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
    raw_fixture = doc.get("fixture")
    if raw_fixture is not None and not isinstance(raw_fixture, str):
        raise ScenarioError(f"{path}: 'fixture' must be a string (name), got {type(raw_fixture).__name__}")
    fixture = raw_fixture or None
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
    return Scenario(name=name, path=path, steps=ordered, xfail=xfail, fixture=fixture)


# #981 S2 — partial execution. Keep only steps whose target is in `targets`,
# PLUS the spawn step (always — it's the infra bootstrap). Lets one scenario
# file feed several runners off a single parse :
#   - full           : every target (CI / container harness)
#   - fake-claude viz : {"human"}                    (bin/play-scenario, #671)
#   - loop-only      : {"human", "expect_inspect"}   (yaml integration, #638)
# The `fixture` (daemon seed) is kept iff "aiball" is among the targets — a
# runner with no daemon has nothing to seed. Returns a NEW Scenario.
def filter_scenario_by_targets(scenario: Scenario, targets: set[str]) -> Scenario:
    kept: list[Step] = [
        s for s in scenario.steps
        if isinstance(s, SpawnStep) or step_target(s) in targets
    ]
    fixture = scenario.fixture if "aiball" in targets else None
    return Scenario(
        name=scenario.name, path=scenario.path,
        steps=tuple(kept), xfail=scenario.xfail, fixture=fixture,
    )


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
    # #981 S2 — `at` is the canonical key (chronological multi-target format) ;
    # `at_seconds` stays accepted as an alias for the #638 scenarios.
    at = raw.get("at", raw.get("at_seconds"))
    if not isinstance(at, (int, float)):
        raise ScenarioError(f"{path} step[{idx}].at: required number on non-spawn steps (or `at_seconds`)")
    if at < 0:
        raise ScenarioError(f"{path} step[{idx}].at: must be >= 0, got {at}")
    if "drive" in keys:
        drive = raw["drive"]
        if not isinstance(drive, dict) or not drive:
            raise ScenarioError(f"{path} step[{idx}].drive: must be a non-empty mapping")
        # The first key is the action name ; everything in the dict is the payload.
        # E.g. `drive: { hook_signal: bootComplete }` → action="hook_signal", payload={"hook_signal": "bootComplete"}.
        action = next(iter(drive))
        return DriveStep(at_seconds=float(at), action=action, payload=dict(drive))
    if "human" in keys:
        # #981 S2 — proxy/human input timeline. `human: { type: "abc" }`,
        # `human: { key: F9 }`, `human: { detach: true }`.
        human = raw["human"]
        if not isinstance(human, dict) or not human:
            raise ScenarioError(f"{path} step[{idx}].human: must be a non-empty mapping")
        action = next(iter(human))
        return HumanStep(at_seconds=float(at), action=action, payload=dict(human))
    if "aiball" in keys:
        # #981 S2 — data-plane mutation timeline. `aiball: { ticket_reply: {...} }`,
        # `aiball: { accept_decision: { ticket: 1 } }`.
        ab = raw["aiball"]
        if not isinstance(ab, dict) or not ab:
            raise ScenarioError(f"{path} step[{idx}].aiball: must be a non-empty mapping")
        action = next(iter(ab))
        return AiballStep(at_seconds=float(at), action=action, payload=dict(ab))
    if "expect" in keys:
        expect = raw["expect"]
        if not isinstance(expect, dict) or not expect:
            raise ScenarioError(f"{path} step[{idx}].expect: must be a non-empty mapping")
        # #981 S2 — explicit layer wrapper : `expect: { daemon: {...} }` or
        # `expect: { inspect: {...} }`. Bare keys (the #638 form) default to
        # the loop `inspect` snapshot. Only a SOLE `daemon`/`inspect` key whose
        # value is a mapping is treated as a wrapper (else it's an assertion).
        assert_target = "inspect"
        if len(expect) == 1:
            sole = next(iter(expect))
            if sole in ("inspect", "daemon") and isinstance(expect[sole], dict):
                assert_target = sole
                inner = expect[sole]
                if not inner:
                    raise ScenarioError(f"{path} step[{idx}].expect.{sole}: must be a non-empty mapping")
                expect = inner
        # Split equality assertions from existence assertions :
        #  - `key: {type: equal|present, value: ...}` → explicit form (#773)
        #  - `key: {present: bool}` → short existence form
        #  - top-level `exists: [path, ...]` → each entry → existence[entry] = True
        #  - everything else → equality assertion (value-compared)
        # The explicit form disambiguates the corner case where a field's
        # expected value is literally a dict with key `present:bool` — under
        # the short form the parser would interpret it as existence.
        assertions: dict = {}
        existence: dict = {}
        for k, v in expect.items():
            if k == "exists":
                if not isinstance(v, list) or not all(isinstance(item, str) for item in v):
                    raise ScenarioError(
                        f"{path} step[{idx}].expect.exists: must be a list of dotted-path strings, got {v!r}"
                    )
                for entry in v:
                    existence[entry] = True
                continue
            if isinstance(v, dict) and "type" in v:
                t = v.get("type")
                if set(v.keys()) - {"type", "value"}:
                    raise ScenarioError(
                        f"{path} step[{idx}].expect.{k}: unexpected keys "
                        f"{sorted(set(v.keys()) - {'type', 'value'})!r} "
                        f"(explicit form takes only `type` and `value`)"
                    )
                if "value" not in v:
                    raise ScenarioError(
                        f"{path} step[{idx}].expect.{k}: `type: {t!r}` requires a `value` key"
                    )
                val = v["value"]
                if t == "equal":
                    assertions[k] = val
                    continue
                if t == "present":
                    if not isinstance(val, bool):
                        raise ScenarioError(
                            f"{path} step[{idx}].expect.{k}.value: `type: present` requires bool, got {type(val).__name__}"
                        )
                    existence[k] = val
                    continue
                raise ScenarioError(
                    f"{path} step[{idx}].expect.{k}.type: must be 'equal' or 'present', got {t!r}"
                )
            if isinstance(v, dict) and set(v.keys()) == {"present"}:
                if not isinstance(v["present"], bool):
                    raise ScenarioError(
                        f"{path} step[{idx}].expect.{k}.present: must be a bool, got {type(v['present']).__name__}"
                    )
                existence[k] = v["present"]
                continue
            assertions[k] = v
        if not assertions and not existence:
            raise ScenarioError(f"{path} step[{idx}].expect: must declare at least one assertion")
        return ExpectStep(at_seconds=float(at), assertions=assertions, existence=existence, assert_target=assert_target)
    raise ScenarioError(
        f"{path} step[{idx}]: must declare one of "
        f"'spawn' / 'drive' / 'human' / 'aiball' / 'expect' "
        f"(got keys: {sorted(keys)})"
    )


def load_scenarios_from_dir(dir_path: Path) -> list[Scenario]:
    """Convenience for the pytest runner : load every `*.yaml` under
    `dir_path`, return the list sorted by scenario name (stable
    ordering across runs). Errors short-circuit — one bad file fails
    the whole load, with the offending path in the message.

    Files whose top-level mapping declares `unit:` (TS unit-from-yaml
    runner per #748) instead of `steps:` are silently skipped — they
    belong to a different runner that shares the same directory."""
    if not dir_path.is_dir():
        raise ScenarioError(f"{dir_path}: not a directory")
    files = sorted(dir_path.glob("*.yaml"))
    out: list[Scenario] = []
    for p in files:
        try:
            doc = yaml.safe_load(p.read_text())
        except yaml.YAMLError as e:
            raise ScenarioError(f"{p}: invalid YAML: {e}") from e
        if isinstance(doc, dict) and "unit" in doc and "steps" not in doc:
            continue
        out.append(parse_scenario(p))
    return out


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
