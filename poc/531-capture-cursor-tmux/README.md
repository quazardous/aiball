# POC: cursor positioning at end of `tmux capture-pane -e -p`

**Goal**: validate empirically what tmux on Linux emits at the tail of
`capture-pane -e -p` output, and how an xterm.js consumer renders the
cursor when the snapshot is written into a fresh terminal.

**Why**: psmux PR psmux/psmux#330 proposed appending a CUP escape at
the end of styled capture to fix a cursor-landing bug for the aiball
web terminal on Windows. Upstream maintainer pushed back (link below),
clarifying that tmux **also** does not emit such an escape and pointing
at the downstream consumer's rendering pipeline as the likely
explanation for why tmux Linux "looks right" while psmux Windows
doesn't.

Three hypotheses to disambiguate:

- **A** — tmux emits something at the tail we're missing (different
  sequence than CUP, or a cursor-show state escape).
- **B** — aiball's Linux deployment renders cursor through a different
  mechanism than the Windows one (different `TerminalView.vue` path,
  different SSE/capture-pane pipeline).
- **C** — the cursor is mis-positioned on tmux Linux too, just not by
  enough rows to be noticed visually (small offset = visual approx
  match).

References:

- Aiball ticket #531 (aiball internal tracker)
- psmux PR https://github.com/psmux/psmux/pull/330 — maintainer
  feedback at https://github.com/psmux/psmux/pull/330#issuecomment-4564239419
- Aiball PR #43 — defensive downstream fix (explicit
  `display-message #{cursor_x},#{cursor_y}` + position via CUP after
  `term.write`).

## Layout

```
poc/531-capture-cursor-tmux/
├── README.md          # this file
├── serve.js           # Node HTTP server: capture-pane + display-message,
│                      # serves /capture (text), /cursor (JSON), /repro (HTML)
├── repro.html         # standalone xterm.js page (loaded via /repro)
└── sample.sh          # bash that spawns a deterministic tmux session
                       # with claude-like content (24-row pane, prompt
                       # at row ~18, last 6 rows empty)
```

No build step. `node serve.js` is the only runtime — Node's stdlib
http + a static xterm.js bundle copied next to repro.html.

## What this POC measures

For both tmux (run on Linux/papy by claude-aiball-dev) AND psmux (run
on Windows graphite by aiball-win), capture the following:

1. **Tail bytes** of `capture-pane -e -p` output, via `od -c | tail`.
   What hex sequences are at the very end?
2. **Cursor coordinates** from `display-message -p '#{cursor_x},#{cursor_y}'`
   immediately after the capture.
3. **Xterm.js cursor row/col** after `term.write(snapshot)` (no
   manual positioning). The repro page logs `term.buffer.active.cursorY`
   and `cursorX` to the JS console.
4. **Difference** between (2) and (3). If they match, the consumer is
   fine without any extra step. If they diverge by N rows, the
   trailing empty rows of the snapshot pushed the cursor down by N.

## How to run

1. Start a deterministic tmux session :

   ```sh
   ./sample.sh
   ```

   Spawns a tmux session named `cursor-poc` in detached mode, sets its
   pane size to 80x24, writes some content + a fake prompt + leaves
   the cursor a few rows above the bottom.

2. Start the POC server :

   ```sh
   node serve.js               # default tmux session `cursor-poc`
   MUX_CMD=psmux node serve.js # explicit psmux on Windows
   PORT=7780 node serve.js     # custom port (default 7777 if free)
   ```

3. Open `http://localhost:7777/repro` in a real browser (Chrome /
   Firefox). The page:
   - Fetches `/capture` (raw text snapshot)
   - Fetches `/cursor` (the JSON `{x, y}` from display-message)
   - Renders into xterm.js
   - Logs the xterm.js cursor position to the JS console
   - Re-fetches every 1 s

4. Inspect:
   - JS console: compare `expected (display-message)` vs
     `actual (xterm.js buffer)`.
   - `od -c` the raw tail of `/capture` (curl + pipe) to see what
     escape sequences land at the very end.

## What to look for

- If tmux's tail contains a sequence we missed (DECSC / DECRC / a CUP
  emitted by a parent render layer) → hypothesis A. Document the
  exact byte sequence, copy into psmux PR comments.
- If tmux's tail is similar to psmux's (`\x1b[0m\n` ad nauseam) AND
  xterm.js cursor still lands correctly via some xterm.js-side magic
  → hypothesis B. Trace into the actual aiball pipeline on Linux
  (`TerminalView.vue applyFrame` for the live path).
- If xterm.js's `cursorY` diverges from `display-message`'s `y` on
  tmux too → hypothesis C. The bug is platform-agnostic; aiball PR
  #43 is the correct fix; psmux PR #330 should withdraw or refactor
  to (c) trim-trailing-empty.

## Out of scope

This POC is read-only: it observes the existing aiball pipeline's
ingredients (capture-pane output, display-message coords) but does
NOT modify aiball or psmux. It's a measurement harness, not a fix.
