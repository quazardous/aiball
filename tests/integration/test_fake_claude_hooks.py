"""#1315 — the hook step type fake-claude gained, tested at its pure core.

The simulator could paint pane text and nothing else, which mirrored the wrong
half of aiball: pane text is the layer being migrated away from, while the hook
events are the layer being migrated to — and some of them (an API failure, a
quota pause) cannot be provoked on demand even with a real Claude.

What is pinned here is the SELECTION, because that is where a mistake would be
silent: picking no command at all still "runs" a scenario, and a scenario that
fires nothing passes exactly like one that fires everything.

Run:
  cd tests/integration
  uv run --with pytest pytest test_fake_claude_hooks.py -q
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _load_fake_claude():
    """Pull `select_hook_commands` out of the real script by AST.

    Not an import: `bin/fake-claude` pulls in `textual`, which the test env has
    no reason to carry. Not a copy either — a copied function is a function
    that stops matching the one that ships. The AST route reads the SOURCE that
    actually runs, and nothing else.
    """
    import ast

    src = (REPO / "bin" / "fake-claude").read_text()
    tree = ast.parse(src)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "select_hook_commands":
            ns: dict = {}
            exec(compile(ast.Module(body=[node], type_ignores=[]), "fake-claude", "exec"), ns)  # noqa: S102
            return type("FC", (), ns)
    raise AssertionError("select_hook_commands vanished from bin/fake-claude")


SETTINGS = {
    "hooks": {
        "SessionStart": [
            {"matcher": "startup", "hooks": [{"type": "command", "command": "run startup"}]},
            {"matcher": "compact", "hooks": [{"type": "command", "command": "run compact"}]},
        ],
        "Notification": [
            {"matcher": "", "hooks": [{"type": "command", "command": "run notification"}]},
        ],
    },
}


def test_an_empty_matcher_matches_everything():
    fc = _load_fake_claude()
    assert fc.select_hook_commands(SETTINGS, "Notification") == ["run notification"]


def test_a_pinned_matcher_fires_only_its_branch():
    fc = _load_fake_claude()
    # Without pinning, a SessionStart scenario would fire startup AND compact.
    assert fc.select_hook_commands(SETTINGS, "SessionStart") == ["run startup", "run compact"]
    assert fc.select_hook_commands(SETTINGS, "SessionStart", "compact") == ["run compact"]


def test_an_unwired_event_selects_nothing_rather_than_guessing():
    fc = _load_fake_claude()
    assert fc.select_hook_commands(SETTINGS, "StopFailure") == []


def test_non_command_handlers_are_skipped():
    fc = _load_fake_claude()
    settings = {"hooks": {"Stop": [{"matcher": "", "hooks": [
        {"type": "http", "url": "https://example.invalid"},
        {"type": "command", "command": "run stop"},
    ]}]}}
    assert fc.select_hook_commands(settings, "Stop") == ["run stop"]
