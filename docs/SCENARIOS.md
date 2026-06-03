# Scenarios — user stories as the single source of truth

This repo runs tests at two levels:

- **Integration** — `tests/integration/*.py` driven by `pytest`, spawn a
  real `claude-loop` instance with the `fake-claude` TUI simulator, walk
  YAML scenarios step-by-step against the live loop. Reach: end-to-end
  behaviour (timer, proxy, tmux paint, hooks). Slow but covers the
  glue.
- **Unit** — `src/**/*.test.ts` via `node:test`. Pure-function
  assertions on state-machine helpers, parsers, dispatchers. Fast.

For a while these two lived in separate worlds. A user story like *"when
the user types a keystroke just after boot exit, NOT AFK 10m arms"* was
described once on each side — or worse, only on one — with no
cross-reference and no guarantee the unit + integration tests stayed
consistent. **`docs/SCENARIOS.md` and the yaml extension introduced in
#748 close that gap.**

## The shared format

Each scenario lives in a single yaml file under
`tests/integration/scenarios/<name>.yaml`. It can carry both an
integration block (the existing `steps:`) and a unit block (the `unit:`
list this doc covers).

```yaml
scenario: afk-sm-basics
description: |
  Human-readable user story (rendered in tests output + the unit-test
  report). One file = one cluster of related user stories sharing
  the same fixture.

# Integration runner (pytest + fake-claude). May be absent for
# unit-only scenarios. See tests/integration/yaml_scenario.py for
# the supported step shapes.
steps:
  - at_seconds: 0
    drive: { keys: "x" }
    expect: { afk_mode: "wait_10m" }

# Unit runner (src/claude-loop/yaml-scenarios.test.ts). May be absent
# for integration-only scenarios. Each entry is one node:test case.
unit:
  - name: "User story phrased as a sentence"
    call:
      module: "./loop-state.js"     # path relative to src/claude-loop/
      fn:     "computeLoopView"
    args:                            # positional, spread into fn(...args)
      - nowMs: 1748534400000
        # ... full input fixture
    expect:                          # dot-paths into the return value
      "barWord": "wait"
      "afkChunk.prefix": "600s"
      "wakeSkipReason": "/NOT AFK/"   # regex match: leading + trailing slash
```

## Adding a user story

1. Pick the scenario file that fits, or create a new one when the cluster
   is fresh. **Name the scenario after the system under test, not the
   author** — `afk-sm-basics.yaml`, not `bug-fix-2026-06-03.yaml`.
2. Phrase each entry as a sentence the user (or reviewer) can read
   standalone. The `name:` becomes the test title; if you can't read it
   without prior context, neither can the next reader.
3. Use the same fixture across related entries to keep the diff small.
   Pull defaults from `baseInput()` in `loop-state.test.ts` (#629
   convention : post-boot, claude ready) when the scenario doesn't care
   about boot-grace.
4. Run `npm test` — every `unit:` entry shows up as a `node:test`
   subtest under `yaml-scenarios :: <scenario> :: <name>`.

## Choosing `unit:` vs `steps:` (or both)

- **`unit:` only** — when the user story is fully captured by a pure
  function. Cheaper to author + run, no fake-claude needed. Most
  state-machine helpers belong here (`computeLoopView`, `computePhase`,
  `dispatchProxyEvent`, ...).
- **`steps:` only** — when the story is a sequence of live events
  (key presses, hook fires, time elapsing) that the pure functions
  don't directly model. Boot detection, picker recovery, /compact
  flow.
- **Both** — when the same story has a black-box and a white-box read.
  The black-box `steps:` exercises the live loop; the `unit:` pins the
  exact state-machine output at each step. Cross-check guarantees that
  a refactor of one half doesn't silently drift the other.

## Expect grammar (unit:)

- Keys with a `.` are dot-paths: `"afkChunk.prefix"` walks
  `result.afkChunk.prefix`.
- Keys without `.` are top-level: `"barWord"` reads `result.barWord`.
- String values shaped like `"/pattern/flags"` are treated as regex
  matches (case-insensitive: `/foo/i`).
- Other values use deep equality (`assert.deepEqual`). Arrays and
  objects compared structurally.

## Where to put the runner / yaml files

| File | Role |
|---|---|
| `tests/integration/scenarios/*.yaml` | The shared scenarios — both runners read from here. |
| `src/claude-loop/yaml-scenarios.test.ts` | The unit runner — picks up every yaml and emits one `node:test` per `unit:` entry. |
| `tests/integration/yaml_scenario.py` + harness | The integration runner — already in place, reads `steps:`. |
| `docs/SCENARIOS.md` | This file. |

The scenarios directory is the single source. Adding/removing yamls
there immediately changes both test suites — no separate registration.

## Conventions

- **One user story per `unit:` entry.** Don't pack multiple assertions
  per call: split into two entries so a failure points at the exact
  story.
- **Describe the SM under test, not the tooling.** Test name reads
  *"AFK wait_inf → bar word `wait`, wake refused, AFK chunk shows ∞"*,
  not *"computeLoopView returns the right object"*.
- **Reference the user story from PR descriptions and ticket bodies.**
  When a marker / config / behaviour change touches a SM, list the
  yaml scenarios that pin it ; reviewers know exactly what they're
  asked to validate.

## Roadmap (what this enables)

- #745 phase B cleanup — every marker drop references an AFK SM
  scenario; remove the marker, run the yaml runner, see if any user
  story regresses.
- #727 V1 hooks UDS — hook event dispatch gets its own scenarios
  (`hook-sm-*.yaml`) that both runners exercise.
- Wake-queue refactor (#749) — the new SM gets a dedicated scenarios
  file (`wake-queue-*.yaml`) from day 1 so the FIFO semantics are
  pinned at every step.

Migrating existing TS unit tests into yaml is out of scope for the POC.
The pattern proves itself on new work first; bulk migration is a
follow-up if it earns its keep.
