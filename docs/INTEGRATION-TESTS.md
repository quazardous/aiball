# Integration tests for `claude-loop`

End-to-end harness for testing `claude-loop` behavior with a deterministic Claude stand-in (`fake-claude --probe-mode`). Shipped under `tests/integration/`.

## Quickstart

```bash
cd tests/integration
uv run --with pytest pytest -q
```

`uv` resolves the `pytest>=7` dep from the PEP-723 comment at the top of `conftest.py` ; nothing to install globally.

## What's in the box

- **`bin/fake-claude --probe-mode SCENARIO`** (#637 slice 1) — non-event-loop runner that renders a built-in scenario synchronously to stdout, advances through it on stdin lines. See `--list-probes` for the catalog.
- **`tests/integration/conftest.py`** (#637 slice 2) — pytest fixtures :
  - `loop_runner(scenario, interval_s=1)` spawns a real `claude-loop` with `CL_CLAUDE_CMD=fake-claude --probe-mode SCENARIO`, runs ONE heartbeat cycle (`--once`), returns a `LoopHandle` with name + state_dir + `.inspect()` shortcut. Cleanup at teardown.
  - `wait_for(predicate, timeout, interval)` sync poll with exception-swallowing — lets tests use one-liners like `wait_for(lambda: handle.inspect()["pane"]["compacting"])` without race-window guards.
- **`tests/integration/test_smoke.py`** (#637 slice 2) — fixture smoke tests : 1 loop-runner E2E + 3 pure `wait_for` units.
- **`tests/integration/test_reference_bugs.py`** (#637 slice 3) — bug-specific regression tests. New bugs land here as the harness matures.

## Adding a new scenario

`bin/fake-claude` carries built-in scenarios in `PROBE_SCENARIOS` (a `dict[str, list[str]]`). Each scenario is a list of screen slugs (defined in `BUILTIN_SCREENS`). Add a new one :

```python
PROBE_SCENARIOS["my-bug"] = ["transition.my_screen", "main.idle"]
```

If the screen slug doesn't exist in `BUILTIN_SCREENS`, define it inline first (see the existing entries for the dict shape). Each screen's `kind` decides how `_render_screen_sync` writes it to stdout (`header_flash`, `write`, `picker`, `prompt`, `stream`).

Probe scenarios advance through their list on stdin lines (any line, including a bare Enter from `tmux send-keys`). `quit` on stdin exits cleanly.

## Adding a new test

Copy a test from `test_reference_bugs.py` as a template :

```python
def test_my_bug_X(loop_runner):
    handle = loop_runner(scenario="my-bug", interval_s=3)
    state = handle.inspect()
    assert state["pane"]["foo"] == "bar", f"#X regression : got {state['pane']!r}"
```

Knobs :
- `interval_s=N` — wait N seconds before the first heartbeat fires (default 1s). Bump it for scenarios that need more render settle time before the probe runs.
- `timeout_s=N` — max wall-clock for `claude-loop start` to exit. Default 20s ; bump for slow MCP boots.
- `wait_for(predicate, timeout, interval)` — for assertions that need to converge across multiple polls rather than a single snapshot.

## Known limitations

- **`pane.compacting` detection is flaky in the harness** (xfailed in `test_650_compacting_detected_during_compact`). Live `/compact` verifies the fix works ; the harness's `--once` exit happens during boot-grace where `proxy.alive=False` and `capturePane()` returns content that doesn't reliably match the regex. Resolving needs PTY proxy involvement in the harness — open ticket once needed.
- **`--once` runs ONE heartbeat then exits**, so the test sees the loop's state at that single tick. Stateful sequences spanning multiple ticks need a different harness (slice 4 / future).
- **fake-claude probe-mode runs sync** — sub-second timings from the textual TUI scenarios (`header_flash` duration, `stream` delays) are intentionally dropped. Tests drive sequencing via stdin advance lines.

## Architecture cheat-sheet

```
┌──────────────────────────────────────────────────────────────────┐
│ pytest (test_reference_bugs.py)                                  │
│   loop_runner(scenario="...", interval_s=N)                       │
└─────────────────────────────────┬────────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│ subprocess : claude-loop start NAME --once --interval N           │
│   env: CL_CLAUDE_CMD=fake-claude --probe-mode SCENARIO           │
└─────────────────────────────────┬────────────────────────────────┘
                                  ▼
┌────────────────────────┐    ┌──────────────────────────────────┐
│ tmux session cl-NAME   │◀───│ fake-claude --probe-mode SCENARIO │
│   pane runs fake-claude│    │   sync stdout render             │
│   capture-pane → state │    │   stdin advance loop             │
└─────────────────┬──────┘    └──────────────────────────────────┘
                  ▼
┌──────────────────────────────────────────────────────────────────┐
│ claude-loop inspect NAME → JSON                                  │
│   view / boot / pane / afk / user_grace / wake / typing / markers│
└─────────────────────────────────┬────────────────────────────────┘
                                  ▼
                  pytest asserts on JSON keys
```

See `docs/CLAUDE-LOOP.md` for the loop architecture itself.
