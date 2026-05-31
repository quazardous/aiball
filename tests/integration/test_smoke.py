"""#637 Slice 2 — smoke tests for the pytest harness.

Validates the conftest fixtures end-to-end : spawn a loop with a
fake-claude probe scenario, wait for the heartbeat to land, inspect
the JSON state, cleanup. Used as the reference / template for the
slice 3 bug-regression tests.
"""

from __future__ import annotations


def test_loop_runner_prompt_ready_completes_one_cycle(loop_runner):
    """`prompt-ready` scenario : the simplest case. Loop spawns, fake-
    claude renders the idle prompt, one heartbeat cycle runs, the
    timer exits cleanly. `inspect()` returns a JSON snapshot with a
    name field matching what we asked for."""
    handle = loop_runner(scenario="prompt-ready")
    state = handle.inspect()
    assert isinstance(state, dict), f"inspect returned non-dict: {state!r}"
    assert state.get("name") == handle.name


def test_loop_runner_picker_scenario_completes(loop_runner):
    """`picker-2-sessions` scenario : fake-claude renders the resume
    picker initially ; the session-start-hook detects it and sends an
    Enter (advancing fake-claude to the idle prompt). One heartbeat
    cycle later the timer exits. Just verify the loop completes
    cleanly — slice 3 will add assertions on the bar / picker markers
    over time."""
    handle = loop_runner(scenario="picker-2-sessions")
    state = handle.inspect()
    assert state.get("name") == handle.name


def test_wait_for_returns_true_when_predicate_fires(wait_for):
    """Pure-fixture test : wait_for polls a predicate that flips to
    true after a short delay. Should return True well within the
    default timeout."""
    import time

    start = time.monotonic()
    target_time = start + 0.3
    ok = wait_for(lambda: time.monotonic() >= target_time, timeout=2.0, interval=0.05)
    assert ok is True


def test_wait_for_returns_false_on_timeout(wait_for):
    """wait_for never throws on a never-true predicate ; it just
    returns False when the timeout fires. Tests then assert."""
    ok = wait_for(lambda: False, timeout=0.2, interval=0.05)
    assert ok is False


def test_wait_for_swallows_predicate_exceptions(wait_for):
    """A predicate raising mid-poll (e.g., inspect not yet ready) is
    treated as 'not truthy yet' — the poller retries. This lets
    tests use a one-liner like `wait_for(lambda:
    handle.inspect()['foo'] == bar)` even when the inspect call
    might fail during the loop's boot window."""
    calls = {"n": 0}

    def predicate():
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("not ready")
        return True

    ok = wait_for(predicate, timeout=2.0, interval=0.05)
    assert ok is True
    assert calls["n"] >= 3
