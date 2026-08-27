# fake-claude — scriptable `claude` simulator for debugging

`bin/fake-claude` is a Python `textual` TUI app that plays a YAML
scenario through a stable layout — header / output log / prompt input
/ footer — mimicking the parts of `claude` that `claude-loop`, its
hooks, and the PTY proxy probe (boot splash, resume picker, prompt,
busy footer with `esc to interrupt`, compacting transition, streaming
output).

Purpose: reproduce bug scenarios without burning real Claude tokens, and
let contributors test claude-loop without an Anthropic subscription.

## Layout

```
┌──────────────────────────────────────────────────┐
│ Static  : "✻ Working…"  /  ""  (boot/busy hint)  │   ← dynamic header
├──────────────────────────────────────────────────┤
│ RichLog : echoes + streamed lines, scrollable    │   ← own region
├──────────────────────────────────────────────────┤
│ Input   : `❯` composer (cursor lives here)       │   ← own region
├──────────────────────────────────────────────────┤
│ Static  : "⏵⏵ auto mode on (shift+tab to cycle)" │   ← state footer
└──────────────────────────────────────────────────┘
```

Each widget owns its own region — no cursor/refresh parasitage between
the prompt input and the streaming output (the bug that killed the
earlier rich-only V0.1).

## Requirements

- `uv` in `PATH` (one-line install: `curl -LsSf https://astral.sh/uv/install.sh | sh`).
- A real TTY (textual won't render in a pipe — it can't, by design).

The shebang `#!/usr/bin/env -S uv run --quiet --script` plus PEP-723
inline metadata declares `textual>=0.50` and `pyyaml>=6` as deps. First
run resolves them into a cached venv (~5 s); subsequent runs are instant.

## Quickstart

```bash
# Default REPL — boot + loop on the idle composer
bin/fake-claude

# A specific scenario
bin/fake-claude examples/fake-claude/scenarios/picker-resume.yaml

# Inside claude-loop (drives a loop with the simulator instead of real claude)
claude-loop start --command "$(realpath bin/fake-claude)"

# List the built-in screen slugs
bin/fake-claude --list-screens
```

Exit: `Ctrl+Q` or `Ctrl+C` (textual standard binding).

## Firing hooks

Painting a screen exercises the pane scrapers. It does **not** exercise the
hook events — `Stop`, `Notification`, `SessionStart` — which is the half of
the runtime that deterministic-signal work depends on, and the half nobody can
provoke on demand: an API failure or a quota pause will not happen because you
want one.

A `hook:` step fires a real handler the way Claude Code would — the payload on
stdin, `CL_STATE_DIR` / `CL_NAME` in the environment:

```yaml
steps:
  - hook: Stop
  - sleep: 61
  - hook:
      event: Notification
      matcher: ""            # optional — pins ONE branch; omit to fire all
      payload:
        notification_type: idle_prompt
        message: "Claude is waiting for your input"
```

The command is read from the `claude-settings.json` claude-loop generated in
the state dir, never reconstructed: a reimplementation would drift from the
real wiring, and the drift would look like a passing test. Requires running
under claude-loop, since that is what creates the state dir.

**Write scenarios from a captured trace, not from the docs.** Generate a real
log first, read what actually happened, then ask how to reproduce it. The
shipped `hook-idle-prompt.yaml` is built that way, and its comments carry the
timeline it came from — including the discriminating case an invented scenario
would have missed, where a second `Stop` inside the minute cancels the
notification entirely.

## Built-in screens

Available without declaring anything in your scenario:

| slug | kind | what it does |
|---|---|---|
| `boot.loading` | header_flash | `✻ Loading Claude…` for 1 s, then clear |
| `boot.resume_picker` | picker | shows the picker block (with `Resume session` + `Space to preview` markers), waits for the next Input.Submitted |
| `transition.resuming` | header_flash | `*  Resuming conversation…` for 2 s |
| `transition.compacting` | header_flash | `✶ Compacting conversation… + esc to interrupt` for 3 s |
| `transition.crunched` | header_flash | `✻ Crunched for 47s` flash |
| `main.idle` | prompt | waits for the user to submit; echoes the line as `> {input}` into the log |
| `main.busy` | header_flash | `✽ Working… + esc to interrupt` for 10 s |
| `main.streaming_output` | stream | sets busy header + pushes 6 lorem lines into the log with random 1–3 s between each, then clears the header |

All strings are kept verbatim so claude-loop's pane-probe regexes
(`esc to interrupt`, `Resume session` + `Space to preview`,
`auto mode on`, `✶ Compacting`, etc.) match on `tmux capture-pane`.

## Scenario shape

```yaml
meta:
  name: picker-resume
  describes: "boot → picker → resume → idle"
  expects_input: true       # this scenario blocks on input somewhere

screens:                    # OPTIONAL — extend or override built-ins
  custom.thinking:
    kind: header_flash
    text: "⏳ thinking really hard…"
    duration: 5.0

steps:
  - screen: boot.loading
  - screen: boot.resume_picker
  - screen: transition.resuming
  - screen: main.idle
  - sleep: 2
  - screen: main.streaming_output
```

### Step kinds

- `sleep: <seconds>` — pause without updating any widget.
- `print: "..."` — push a literal line into the output log.
- `screen: <slug>` — play a built-in or scenario-defined screen.
- `loop: [step, ...]` — repeat the inner steps (infinite, or `times: N`).

### Screen kinds (referenced by built-ins, can be re-used in scenarios)

- `kind: header_flash` — set the header to `text` for `duration` seconds, then clear.
- `kind: write` — push `text` as one line into the output log.
- `kind: picker` — push `lines` (a list) into the log, set the header to
  a "[choose…]" hint, wait for the next Input.Submitted, then clear.
- `kind: prompt` — wait for the user to submit; echo the line as `> {input}`.
- `kind: stream` — set busy header, push `lines` one by one with random
  `delay_min` / `delay_max` between each, up to `max_lines`, then clear.

## Shipped scenarios

In `examples/fake-claude/scenarios/`:

- `default.yaml` — boot + loop on the idle composer with lorem streams.
  Loaded automatically when `fake-claude` is called with no argument.
- `picker-resume.yaml` — boot → picker → resume → idle.
- `quick-prompt.yaml` — boot → idle (baseline, no picker).
- `boot-stuck.yaml` — boot that never finishes (10 min sleep).
- `busy-immediate.yaml` — boot, brief idle, then `main.busy` for 10 s.
- `compacting.yaml` — idle → `transition.compacting` 3 s → idle.

## Limitations

- Textual requires a real TTY — `bin/fake-claude scenarios/foo.yaml | head`
  does not work and never will. For non-interactive smoke (CI), drive the
  app via `App.run_test()` in a Python harness instead.
- YAML-defined `kind: prompt` screens have no way to declare an
  `on_timeout`. The user is expected to type something.
- No syntax highlighting / markdown rendering inside the output log —
  it's a plain RichLog. Easy to upgrade if a scenario needs it.
