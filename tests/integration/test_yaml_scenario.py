"""#638 Slice 1 — unit tests for yaml_scenario parser + validator.

Pure tests (no claude-loop, no fake-claude, no fs side-effects beyond
tmp_path) ; the slice 2 runner exercises the parsed scenarios end-to-end.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure the test's own directory is on sys.path so `yaml_scenario`
# resolves regardless of how pytest is invoked (rootdir, importmode,
# etc.). Cheap + isolates this test from any future repo-wide
# package layout decisions.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from yaml_scenario import (  # noqa: E402
    AiballStep,
    DriveStep,
    ExpectStep,
    HumanStep,
    Scenario,
    ScenarioError,
    SpawnStep,
    filter_scenario_by_targets,
    get_inspect_path,
    load_scenarios_from_dir,
    parse_scenario,
    step_target,
)


def write(tmp_path: Path, name: str, content: str) -> Path:
    """Convenience : write a tmp yaml file and return its path."""
    p = tmp_path / name
    p.write_text(content)
    return p


# ---------------------------------------------------------------------
# happy path
# ---------------------------------------------------------------------

def test_parse_minimal_scenario(tmp_path: Path):
    """A scenario with one spawn + one expect parses to a Scenario
    with 2 ordered steps, the spawn first."""
    p = write(tmp_path, "boot.yaml", """\
scenario: boot-minimal
steps:
  - spawn: { fake_claude: prompt-ready }
  - at_seconds: 5
    expect:
      bar_word: boot
""")
    sc = parse_scenario(p)
    assert sc.name == "boot-minimal"
    assert sc.path == p
    assert len(sc.steps) == 2
    assert isinstance(sc.steps[0], SpawnStep)
    assert sc.steps[0].fake_claude == "prompt-ready"
    assert isinstance(sc.steps[1], ExpectStep)
    assert sc.steps[1].at_seconds == 5
    assert sc.steps[1].assertions == {"bar_word": "boot"}


def test_parse_scenario_name_falls_back_to_filestem(tmp_path: Path):
    """Missing `scenario:` key → name = file stem."""
    p = write(tmp_path, "f9-toggle.yaml", """\
steps:
  - spawn: { fake_claude: prompt-ready }
""")
    sc = parse_scenario(p)
    assert sc.name == "f9-toggle"


def test_parse_drive_step(tmp_path: Path):
    """drive step shape : action = first key, payload = whole dict."""
    p = write(tmp_path, "drive.yaml", """\
scenario: drive-x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at_seconds: 3
    drive: { hook_signal: bootComplete }
""")
    sc = parse_scenario(p)
    drive = sc.steps[1]
    assert isinstance(drive, DriveStep)
    assert drive.at_seconds == 3
    assert drive.action == "hook_signal"
    assert drive.payload == {"hook_signal": "bootComplete"}


def test_steps_sorted_by_at_seconds(tmp_path: Path):
    """Timed steps in any order in the yaml end up sorted at_seconds-asc
    in the parsed Scenario. Spawn stays first."""
    p = write(tmp_path, "ord.yaml", """\
scenario: order
steps:
  - spawn: { fake_claude: prompt-ready }
  - at_seconds: 32
    expect: { bar_word: loop }
  - at_seconds: 5
    drive: { hook_signal: bootComplete }
  - at_seconds: 10
    expect: { in_boot_grace: true }
""")
    sc = parse_scenario(p)
    times = [getattr(s, "at_seconds", 0.0) for s in sc.steps]
    assert times == [0.0, 5.0, 10.0, 32.0], f"steps not time-ordered : got {times}"


# ---------------------------------------------------------------------
# validation errors
# ---------------------------------------------------------------------

def test_empty_file_rejected(tmp_path: Path):
    p = write(tmp_path, "empty.yaml", "")
    with pytest.raises(ScenarioError, match="empty YAML document"):
        parse_scenario(p)


def test_invalid_yaml_rejected(tmp_path: Path):
    p = write(tmp_path, "bad.yaml", "scenario: x\n  : broken")
    with pytest.raises(ScenarioError, match="invalid YAML"):
        parse_scenario(p)


def test_top_level_must_be_mapping(tmp_path: Path):
    p = write(tmp_path, "list.yaml", "- a\n- b\n")
    with pytest.raises(ScenarioError, match="top-level YAML must be a mapping"):
        parse_scenario(p)


def test_steps_required(tmp_path: Path):
    p = write(tmp_path, "nosteps.yaml", "scenario: x\n")
    with pytest.raises(ScenarioError, match="'steps' must be a list"):
        parse_scenario(p)


def test_steps_must_not_be_empty(tmp_path: Path):
    p = write(tmp_path, "emptysteps.yaml", "scenario: x\nsteps: []\n")
    with pytest.raises(ScenarioError, match="'steps' must not be empty"):
        parse_scenario(p)


def test_spawn_must_be_first(tmp_path: Path):
    p = write(tmp_path, "spawn-late.yaml", """\
scenario: x
steps:
  - at_seconds: 1
    expect: { bar_word: boot }
  - spawn: { fake_claude: prompt-ready }
""")
    with pytest.raises(ScenarioError, match="'spawn' step must be the FIRST step"):
        parse_scenario(p)


def test_missing_spawn_rejected(tmp_path: Path):
    p = write(tmp_path, "nospawn.yaml", """\
scenario: x
steps:
  - at_seconds: 1
    expect: { bar_word: boot }
""")
    with pytest.raises(ScenarioError, match="missing 'spawn' step"):
        parse_scenario(p)


def test_multiple_spawn_rejected(tmp_path: Path):
    p = write(tmp_path, "twin-spawn.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - spawn: { fake_claude: compacting-42 }
""")
    with pytest.raises(ScenarioError, match="more than one 'spawn' step"):
        parse_scenario(p)


def test_spawn_requires_fake_claude_key(tmp_path: Path):
    p = write(tmp_path, "badspawn.yaml", """\
scenario: x
steps:
  - spawn: { wrong_key: y }
""")
    with pytest.raises(ScenarioError, match="spawn.fake_claude"):
        parse_scenario(p)


def test_at_seconds_required_on_non_spawn(tmp_path: Path):
    p = write(tmp_path, "noat.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - expect: { bar_word: boot }
""")
    with pytest.raises(ScenarioError, match="at_seconds.*required number"):
        parse_scenario(p)


def test_at_seconds_must_be_non_negative(tmp_path: Path):
    p = write(tmp_path, "neg.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at_seconds: -1
    expect: { bar_word: boot }
""")
    with pytest.raises(ScenarioError, match=">= 0"):
        parse_scenario(p)


def test_step_must_declare_known_kind(tmp_path: Path):
    p = write(tmp_path, "unknown.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at_seconds: 1
    weird_key: 42
""")
    with pytest.raises(ScenarioError, match="must declare one of"):
        parse_scenario(p)


# ---------------------------------------------------------------------
# load_scenarios_from_dir
# ---------------------------------------------------------------------

def test_load_scenarios_from_dir_returns_sorted(tmp_path: Path):
    write(tmp_path, "b.yaml", "scenario: b\nsteps:\n  - spawn: { fake_claude: prompt-ready }\n")
    write(tmp_path, "a.yaml", "scenario: a\nsteps:\n  - spawn: { fake_claude: prompt-ready }\n")
    sc_list = load_scenarios_from_dir(tmp_path)
    names = [sc.name for sc in sc_list]
    # Sorted by path → a.yaml before b.yaml
    assert names == ["a", "b"]


def test_load_scenarios_rejects_non_directory(tmp_path: Path):
    p = write(tmp_path, "single.yaml", "scenario: x\nsteps: [{spawn: {fake_claude: prompt-ready}}]\n")
    with pytest.raises(ScenarioError, match="not a directory"):
        load_scenarios_from_dir(p)


def test_load_scenarios_one_bad_file_fails_whole_load(tmp_path: Path):
    write(tmp_path, "good.yaml", "scenario: good\nsteps:\n  - spawn: { fake_claude: prompt-ready }\n")
    write(tmp_path, "bad.yaml", "scenario: bad\nsteps: []\n")
    with pytest.raises(ScenarioError, match="must not be empty"):
        load_scenarios_from_dir(tmp_path)


# ---------------------------------------------------------------------
# get_inspect_path
# ---------------------------------------------------------------------

def test_get_inspect_path_leaf():
    snap = {"pane": {"compacting": True, "busy": False}}
    assert get_inspect_path(snap, "pane.compacting") is True
    assert get_inspect_path(snap, "pane.busy") is False


def test_get_inspect_path_nested():
    snap = {"view": {"afk_chunk": {"label": "AFK"}}}
    assert get_inspect_path(snap, "view.afk_chunk.label") == "AFK"


def test_get_inspect_path_missing_key_raises():
    snap = {"pane": {"busy": True}}
    with pytest.raises(KeyError, match="pane.missing"):
        get_inspect_path(snap, "pane.missing")


def test_get_inspect_path_parent_not_mapping_raises():
    snap = {"pane": "scalar"}
    with pytest.raises(KeyError, match="parent is not a mapping"):
        get_inspect_path(snap, "pane.x")


# ---------------------------------------------------------------------
# #760 / #773 — present / exists / explicit type grammar
# ---------------------------------------------------------------------

def test_expect_short_present_form(tmp_path: Path):
    """`key: {present: true}` → existence[key] = True."""
    p = write(tmp_path, "p.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at_seconds: 1
    expect:
      pane: { present: true }
      view: { present: false }
""")
    sc = parse_scenario(p)
    step = sc.steps[1]
    assert isinstance(step, ExpectStep)
    assert step.assertions == {}
    assert step.existence == {"pane": True, "view": False}


def test_expect_exists_batch_form(tmp_path: Path):
    """Top-level `exists: [a, b]` → existence[a]=existence[b]=True."""
    p = write(tmp_path, "e.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at_seconds: 1
    expect:
      exists: [boot, runtime, markers]
""")
    sc = parse_scenario(p)
    step = sc.steps[1]
    assert isinstance(step, ExpectStep)
    assert step.assertions == {}
    assert step.existence == {"boot": True, "runtime": True, "markers": True}


def test_expect_explicit_type_present(tmp_path: Path):
    """`key: {type: present, value: bool}` → existence[key] = bool."""
    p = write(tmp_path, "tp.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at_seconds: 1
    expect:
      pane: { type: present, value: true }
      stale: { type: present, value: false }
""")
    sc = parse_scenario(p)
    step = sc.steps[1]
    assert isinstance(step, ExpectStep)
    assert step.existence == {"pane": True, "stale": False}


def test_expect_explicit_type_equal_disambiguates_present_literal(tmp_path: Path):
    """`{type: equal, value: {present: true}}` → equality against the literal
    dict — disambiguates the short-form ambiguity (#773 motivation)."""
    p = write(tmp_path, "te.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at_seconds: 1
    expect:
      some.field:
        type: equal
        value: { present: true }
""")
    sc = parse_scenario(p)
    step = sc.steps[1]
    assert isinstance(step, ExpectStep)
    assert step.existence == {}
    assert step.assertions == {"some.field": {"present": True}}


def test_expect_explicit_type_equal_scalar(tmp_path: Path):
    """`type: equal` form also works with scalar values."""
    p = write(tmp_path, "ts.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at_seconds: 1
    expect:
      view.bar_word: { type: equal, value: boot }
""")
    sc = parse_scenario(p)
    step = sc.steps[1]
    assert step.assertions == {"view.bar_word": "boot"}
    assert step.existence == {}


def test_expect_explicit_unknown_type_raises(tmp_path: Path):
    p = write(tmp_path, "tu.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at_seconds: 1
    expect:
      pane: { type: maybe, value: true }
""")
    with pytest.raises(ScenarioError, match="must be 'equal' or 'present'"):
        parse_scenario(p)


def test_expect_explicit_missing_value_raises(tmp_path: Path):
    p = write(tmp_path, "tmv.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at_seconds: 1
    expect:
      pane: { type: present }
""")
    with pytest.raises(ScenarioError, match="requires a `value` key"):
        parse_scenario(p)


def test_expect_explicit_extra_keys_raises(tmp_path: Path):
    """The explicit form takes exactly `type` and `value` — extra keys are
    rejected to keep the contract narrow."""
    p = write(tmp_path, "tek.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at_seconds: 1
    expect:
      pane: { type: present, value: true, extra: 1 }
""")
    with pytest.raises(ScenarioError, match="unexpected keys"):
        parse_scenario(p)


def test_expect_explicit_present_non_bool_raises(tmp_path: Path):
    p = write(tmp_path, "tnb.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at_seconds: 1
    expect:
      pane: { type: present, value: 42 }
""")
    with pytest.raises(ScenarioError, match="`type: present` requires bool"):
        parse_scenario(p)


def test_expect_mixed_forms_in_one_step(tmp_path: Path):
    """All four forms (scalar / short-present / exists / explicit) coexist
    in the same `expect:` block."""
    p = write(tmp_path, "mix.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at_seconds: 1
    expect:
      view.bar_word: boot
      pane: { present: true }
      exists: [runtime, markers]
      some.field: { type: equal, value: { present: true } }
""")
    sc = parse_scenario(p)
    step = sc.steps[1]
    assert isinstance(step, ExpectStep)
    assert step.assertions == {"view.bar_word": "boot", "some.field": {"present": True}}
    assert step.existence == {"pane": True, "runtime": True, "markers": True}


# ---------------------------------------------------------------------
# #981 S2 — fixture, multi-target steps (human/aiball), expect routing,
# `at` alias, partial-execution filtering.
# ---------------------------------------------------------------------

def test_at_alias_equivalent_to_at_seconds(tmp_path: Path):
    """`at:` is the canonical key but `at_seconds:` still works (back-compat)."""
    p = write(tmp_path, "atalias.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at: 3
    expect: { view.bar_word: idle }
""")
    sc = parse_scenario(p)
    assert sc.steps[1].at_seconds == 3.0


def test_fixture_parsed(tmp_path: Path):
    p = write(tmp_path, "fix.yaml", """\
scenario: x
fixture: resolution-pending
steps:
  - spawn: { fake_claude: prompt-ready }
""")
    sc = parse_scenario(p)
    assert sc.fixture == "resolution-pending"


def test_fixture_absent_is_none(tmp_path: Path):
    p = write(tmp_path, "nofix.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
""")
    assert parse_scenario(p).fixture is None


def test_fixture_must_be_string(tmp_path: Path):
    p = write(tmp_path, "badfix.yaml", """\
scenario: x
fixture: [1, 2]
steps:
  - spawn: { fake_claude: prompt-ready }
""")
    with pytest.raises(ScenarioError, match="'fixture' must be a string"):
        parse_scenario(p)


def test_human_step(tmp_path: Path):
    p = write(tmp_path, "human.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at: 2
    human: { type: "abc" }
  - at: 4
    human: { key: F9 }
""")
    sc = parse_scenario(p)
    s1, s2 = sc.steps[1], sc.steps[2]
    assert isinstance(s1, HumanStep) and s1.action == "type" and s1.payload == {"type": "abc"}
    assert isinstance(s2, HumanStep) and s2.action == "key" and s2.payload == {"key": "F9"}
    assert step_target(s1) == "human"


def test_aiball_step(tmp_path: Path):
    p = write(tmp_path, "aiball.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at: 2
    aiball: { accept_decision: { ticket: 1 } }
""")
    sc = parse_scenario(p)
    s = sc.steps[1]
    assert isinstance(s, AiballStep) and s.action == "accept_decision"
    assert s.payload == {"accept_decision": {"ticket": 1}}
    assert step_target(s) == "aiball"


def test_expect_inspect_is_default_target(tmp_path: Path):
    p = write(tmp_path, "expi.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at: 1
    expect: { pane.busy: true }
""")
    s = parse_scenario(p).steps[1]
    assert isinstance(s, ExpectStep) and s.assert_target == "inspect"
    assert step_target(s) == "expect_inspect"


def test_expect_daemon_target(tmp_path: Path):
    p = write(tmp_path, "expd.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at: 1
    expect:
      daemon:
        ticket.1.status: open
""")
    s = parse_scenario(p).steps[1]
    assert isinstance(s, ExpectStep) and s.assert_target == "daemon"
    assert s.assertions == {"ticket.1.status": "open"}
    assert step_target(s) == "expect_daemon"


def test_expect_inspect_wrapper_explicit(tmp_path: Path):
    p = write(tmp_path, "expiw.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at: 1
    expect:
      inspect:
        pane.busy: false
""")
    s = parse_scenario(p).steps[1]
    assert isinstance(s, ExpectStep) and s.assert_target == "inspect"
    assert s.assertions == {"pane.busy": False}


def test_sole_daemon_assertion_not_treated_as_wrapper(tmp_path: Path):
    """A non-dict value under a sole `daemon` key is a plain assertion,
    not a layer wrapper (the wrapper requires a mapping value)."""
    p = write(tmp_path, "expda.yaml", """\
scenario: x
steps:
  - spawn: { fake_claude: prompt-ready }
  - at: 1
    expect: { daemon: 42 }
""")
    s = parse_scenario(p).steps[1]
    assert s.assert_target == "inspect"
    assert s.assertions == {"daemon": 42}


def _full(tmp_path: Path) -> Scenario:
    p = write(tmp_path, "full.yaml", """\
scenario: full
fixture: seed-1
steps:
  - spawn: { fake_claude: prompt-ready }
  - at: 1
    drive: { hook_signal: bootComplete }
  - at: 2
    human: { type: "abc" }
  - at: 3
    aiball: { accept_decision: { ticket: 1 } }
  - at: 4
    expect: { pane.busy: true }
  - at: 5
    expect: { daemon: { ticket.1.status: open } }
""")
    return parse_scenario(p)


def test_filter_fake_claude_viz(tmp_path: Path):
    """Viz mode = just the human timeline ; spawn always kept ; fixture
    dropped (no daemon)."""
    sc = filter_scenario_by_targets(_full(tmp_path), {"human"})
    kinds = [step_target(s) for s in sc.steps]
    assert kinds == ["spawn", "human"]
    assert sc.fixture is None


def test_filter_loop_only(tmp_path: Path):
    """Loop-only = human + inspect expectations ; no daemon/aiball, no fixture."""
    sc = filter_scenario_by_targets(_full(tmp_path), {"loop", "human", "expect_inspect"})
    kinds = [step_target(s) for s in sc.steps]
    assert kinds == ["spawn", "loop", "human", "expect_inspect"]
    assert sc.fixture is None


def test_filter_full_keeps_everything(tmp_path: Path):
    sc = filter_scenario_by_targets(
        _full(tmp_path),
        {"loop", "human", "aiball", "expect_inspect", "expect_daemon"},
    )
    kinds = [step_target(s) for s in sc.steps]
    assert kinds == ["spawn", "loop", "human", "aiball", "expect_inspect", "expect_daemon"]
    assert sc.fixture == "seed-1"
