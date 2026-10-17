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
npx tsx scripts/attention-report.ts --weight tokens     # share periods by tokens spent
npx tsx scripts/attention-report.ts --counterfactual    # also: Claude sessions alone
npx tsx scripts/attention-report.ts --project helios,mcu --json
npx tsx scripts/attention-report.ts --since 1d --json --tickets  # + the tickets touched, per day and project
```

With `--json --tickets` the JSON also lists, per day and project, the tickets
the human acted on (a comment, a decision, a close, a creation, a gesture in a
UI), with their title, summary and number of acts, most acts first.

## What it reads

| source | how far back | what it gives |
|---|---|---|
| the board (`aiball.db`) | everything | what a human wrote (comments, tickets, closes) and decided (accept, reject); the tickets agents filed |
| Claude transcripts (`~/.claude/projects/*/*.jsonl`) | what Claude Code keeps (30 days by default) | the prompts typed into a session, and the tokens each answer spent |
| loop logs (`~/.claude-loop/*/loop.log`) | since each loop last started | bursts of keys at the terminal |
| UI actions (`$AIBALL_HOME/ui-actions/`) | `logs.ui_actions.retention` (180 days by default) | the human's gestures in the web board, tvty or the CLI: reading a ticket, searching, typing into a session |

A loop's wakes are typed into the same prompt as a human's, so a transcript
cannot tell them apart by who typed them. They are told apart by their text:
the forms a wake takes (`look #N`, `(#N / #hash)`, `was ACCEPTED`, …).

A ticket an agent files is usually one the human asked for, while watching, so
it counts as the human's trace too, but only when one of the human's acts is
within 30 minutes: an agent working on its own also files tickets, at night.
It lengthens a period the human was in; it never makes one up.
`--no-agent-tickets` leaves them out.

The UI actions are one line per bus call a human makes — the method, the
project, the ticket, never a text — in one file per day, gzipped once past. A UI
left open calls on its own, so only the calls listed as gestures count
(`UI_GESTURES` in `src/devtools/attention-sources.ts`).

The `src` column says what a day rests on: `b` board, `c` transcripts, `l` loop
logs, `u` UI actions. The fewer the letters, the less the day's estimate rests on.

## How it estimates: snapping

Typing is the only part anything records directly; reading, watching an agent
and thinking leave no trace. So each recorded act is a point in time, and acts
close to one another **snap together into one continuous period of work**: the
human was there between them. A period opens a little before its first act
(getting into it) and closes a little after its last (reading what came back):

```
─[lead]─●──●─●───────●──●─[tail]─        ●─[…]
         gaps ≤ snap: one period          gap > snap: a new period
```

Each period is then **shared among the projects worked on in it**:

- `--weight acts` (the default): in proportion to the human's acts on each;
- `--weight tokens`: in proportion to what each project's Claude sessions spent
  during the period (new input and output; re-reading a cached context does
  not count). It says where the work went, not only where the human typed. A
  period with no tokens falls back to acts.

Each parameter is an assumption, so the model runs three times and a cell can
show the range:

| | low | median | high |
|---|---|---|---|
| snap: a pause still inside the same work | 5 min | 10 min | 20 min |
| lead: before the first act | 1 min | 3 min | 5 min |
| tail: after the last act | 1 min | 5 min | 10 min |

They live in `src/devtools/attention-model.ts` (`PARAM_SETS`). Calibrate them
by noting what you actually did over a stretch of time and comparing.

## Past Claude's transcripts

Claude Code keeps its transcripts for 30 days by default, the board and the UI
log for much longer. Before the first day the transcripts cover, the estimate
is degraded rather than blind:

- on the days the transcripts cover (the training window), the model runs twice:
  with every source, and with the durable ones alone (the board, the UI log);
- per project, the ratio of the two is that project's factor. A project with
  less than an hour of durable time in the window takes the overall factor;
- each older day gets its durable estimate times the factor, and `~` in its
  `src` column. The report says which window the factors come from, and lists
  them (`--json` has them all, for each of the three runs).

## Claude sessions alone

The counterfactual table keeps every human act, and adds the ones aiball made
unnecessary:

- each loop wake becomes a prompt the human types;
- each comment an agent posted on another project's ticket becomes a message
  the human carries by hand to that project's session.

The added acts snap like the others: they lengthen periods and bridge gaps. A
project can show fewer hours in that table than in the real one, because a
shared period is split differently. The total is what compares.
