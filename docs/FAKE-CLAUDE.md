# fake-claude — scriptable `claude` simulator for debugging

`bin/fake-claude` is a Python script that plays a YAML scenario on
stdout/stdin, mimicking the parts of `claude` that `claude-loop`,
its hooks, and the pty-proxy care about — boot splash, resume picker,
prompt, busy footer (`esc to interrupt`), compacting transition.

Purpose: reproduce bug scenarios without burning real Claude tokens, and
let contributors test claude-loop without an Anthropic subscription.

## Quickstart

```bash
# Standalone run (pipe to a terminal to see the simulated screens)
bin/fake-claude examples/fake-claude/scenarios/picker-resume.yaml

# Inside claude-loop (replaces the real `claude` binary)
claude-loop start --command "bin/fake-claude $(pwd)/examples/fake-claude/scenarios/picker-resume.yaml"

# List the built-in screen slugs your scenarios can reference
bin/fake-claude --list-screens
```

Requires `pyyaml` (`pip install pyyaml`).

## Built-in screens

Available without declaring anything in your scenario:

| slug | what it emits |
|---|---|
| `boot.loading` | `✻ Loading Claude…` (1s) |
| `boot.resume_picker` | `Resume session — Space to preview` picker (waits for input) |
| `transition.resuming` | `* Resuming conversation…` (2s) |
| `transition.compacting` | `✶ Compacting conversation… + esc to interrupt` (3s) |
| `main.idle` | prompt `❯` + `⏵⏵ auto mode on (shift+tab to cycle)` footer |
| `main.busy` | `✽ Working… + esc to interrupt` (10s) |
| `main.with_question` | placeholder AskUserQuestion box (waits for 1/2/3) |

All strings are kept verbatim to match the regexes claude-loop already
relies on (`esc to interrupt`, `Resume session` + `Space to preview`,
`auto mode on`, etc.).

## Scenario shape

```yaml
meta:
  name: picker-resume
  describes: "boot → picker → resume → idle"
  expects_input: true     # this scenario blocks on stdin somewhere

screens:                  # OPTIONAL — extend or override built-ins
  custom.thinking:
    print: "⏳ thinking really hard…\n"
    duration: 5.0

steps:
  - screen: boot.loading
  - screen: boot.resume_picker
  - screen: transition.resuming
  - screen: main.idle
  - sleep: 2
  - print: "extra inline output\n"
  - screen: main.busy
```

### Step kinds

- `sleep: <seconds>` — pause without printing.
- `print: "..."` — write the literal string to stdout.
- `screen: <slug>` — play a built-in or scenario-defined screen.

### Screen kinds

- `print: "..."` — emitted as-is.
- `duration: <seconds>` — sleep after printing (auto-clear effect).
- `wait_input: { type, ... }` — block on stdin:
  - `type: line` — accept any line.
  - `type: choice`, `choices: [...]` — only accept listed strings.
  - `type: regex`, `pattern: "..."` — accept lines matching the regex.
  - Optional `timeout: <seconds>` + `on_timeout: <label>` — give up after N seconds.

## Shipped scenarios

In `examples/fake-claude/scenarios/`:

- `picker-resume.yaml` — boot → picker → resume → idle.
- `quick-prompt.yaml` — boot → idle (baseline, no picker).
- `boot-stuck.yaml` — boot that never finishes (10 min sleep). Tests
  boot-grace expiry handling.
- `busy-immediate.yaml` — boot, brief idle, then `main.busy` for 10s.
  Tests `esc to interrupt` gating (auto-wakes should NOT fire during).
- `compacting.yaml` — idle → `transition.compacting` 3s → idle. Tests
  live-vs-stale compacting detection.

## Limitations

V0 by design:

- No fancy TTY (no cursor positioning, no clear-screen). Each screen
  just appends text. Good enough for the regex-driven probes claude-loop
  uses; not good enough to fake `claude`'s full interactive UI.
- `wait_input` reads line-buffered — for sub-line keystroke replay (raw
  keypresses, function keys), wire it through the pty-proxy instead.
- No branching / conditional steps. If a scenario needs branches, fork
  it into two scenario files.

Contributions welcome — drop new scenarios in
`examples/fake-claude/scenarios/`, ideally with a one-line `describes`
in `meta:` so other contributors find them.
