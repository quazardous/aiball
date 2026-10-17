# Attention report

How many hours the human worked, per project and per day, estimated from the
traces aiball and Claude Code already keep. It answers a second question with
the same data: how many hours the same work would have taken with Claude
sessions alone, without aiball.

It is a report. It reads the board's database read-only, the Claude Code
transcripts and the loop logs, and writes nothing.

```bash
npx tsx scripts/attention-report.ts                     # the last 30 days
npx tsx scripts/attention-report.ts --since 7d --range  # low–median–high per cell
npx tsx scripts/attention-report.ts --counterfactual    # also: Claude sessions alone
npx tsx scripts/attention-report.ts --project helios,mcu --json
```

## What it reads

| source | how far back | what it gives |
|---|---|---|
| the board (`aiball.db`) | everything | what a human wrote (comments, tickets, closes) and decided (accept, reject), and the text each one answered |
| Claude transcripts (`~/.claude/projects/*/*.jsonl`) | what Claude Code keeps (30 days by default) | the prompts typed into a session, and the agent's text before each |
| loop logs (`~/.claude-loop/*/loop.log`) | since each loop last started | bursts of keys at the terminal |

A loop's wakes are typed into the same prompt as a human's, so a transcript
cannot tell them apart by who typed them. They are told apart by their text:
the forms a wake takes (`look #N`, `(#N / #hash)`, `was ACCEPTED`, …).

The `src` column says what a day rests on: `b` board, `c` transcripts, `l` loop
logs. The fewer the letters, the less the day's estimate rests on.

## How it estimates

Typing is the only part anything records directly. Each recorded act is taken
as the visible tip of a longer stretch of attention:

```
[switch][read what prompted it][type it] ● [watch what follows]
```

- **switch** — a fixed cost when the act lands on another project than the one
  before, or after a pause of more than 15 minutes;
- **read** — the text that came in since the human's previous act there, at a
  reading speed, capped;
- **type** — the act's own text, at a typing speed;
- **watch** — a while after the act, cut short by the next one.

The stretches go on one timeline. Where two overlap, the later one takes over
from its start: one human, one project at a time.

Every parameter is an assumption, so the model runs three times and a cell can
show the range:

| | low | median | high |
|---|---|---|---|
| reading | 20 chars/s | 15 chars/s | 10 chars/s |
| typing | 6 chars/s | 4 chars/s | 3 chars/s |
| project switch | 20 s | 1 min | 2 min |
| watching after an act | 30 s | 2 min | 5 min |
| most reading per act | 5 min | 10 min | 15 min |

They live in `src/devtools/attention-model.ts` (`PARAM_SETS`). Calibrate them
by noting what you actually did over a stretch of time and comparing.

## Claude sessions alone

The counterfactual table keeps every human act, and adds the ones aiball made
unnecessary:

- each loop wake becomes a prompt the human types (a short one), after reading
  the agent's output before it;
- each comment an agent posted on another project's ticket becomes a message
  the human carries by hand to that project's session.

A project can show fewer hours in that table than in the real one: an added act
takes over the time of the stretch it lands in. The total is what compares.
