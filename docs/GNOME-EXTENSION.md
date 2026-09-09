# The GNOME Shell extension

A top-bar indicator for the aiball daemon: whether it is up, which version, and
how much is waiting for you. It is the Linux counterpart of the Windows tray —
but not a port of it, for reasons worth stating before you install it.

## Install

```bash
aiball init gnome-extension
gnome-extensions enable aiball@quazardous.github.io
```

The extension is then live on X11 after `Alt+F2`, `r`; on Wayland the shell has
to be restarted, so log out and back in.

Refresh it after an aiball upgrade with `aiball init gnome-extension
--overwrite`. A refresh **replaces** the installed directory rather than
merging into it: a stale file from an older layout would otherwise be loaded
by the shell alongside the new ones, and nothing would say so.

## What it is not

**It does not supervise the daemon.** The Windows tray polls every few seconds
and restarts what it finds dead, because a Windows user session has no service
manager. On Linux `systemctl --user` already does that job, has done it longer,
and does it better. A second watcher would duplicate it and could fight it —
so this extension is visibility and shortcuts, and nothing else.

## What it shows

The top bar carries **one** number: tickets waiting on a human decision. That
is the count that should make you look up; a bar full of numbers is a bar
nobody reads. Everything else is one click away in the menu:

- the daemon's state and version,
- tickets to moderate, actionable tickets, open tickets — summed across every
  project,
- how many loops are running,
- shortcuts to open the board, restart the daemon, and reload the config.

## No token lives in it

The extension talks to the **Unix socket**, never the HTTP port. That is a
deliberate design point rather than a convenience: a client on the port needs a
credential, whereas the socket's trust boundary is the operating system's — a
process of the same user may open it, and a GNOME extension already is one. So
there is nothing to store, nothing to rotate, and nothing to leak from a
desktop component.

There is a test that fails if the extension ever grows an authorization header.

## Refresh rates, and why they differ

Liveness is polled every 5 seconds, counters every 30. The two are not the same
cost: the health check answers in about 1.5 ms, while the counters cost 150-220
ms on a real board, and the daemon serves callers one at a time. Polling the
expensive one often would spend a noticeable slice of the daemon on a panel
nobody is looking at.

The rule that matters more than either interval: **the counters refresh when
the menu opens**. The number you read is fresh at the moment you read it, and
the idle cost stays at 1.5 ms every 5 seconds.

## The maintenance it commits you to

A GNOME extension declares the Shell versions it supports in `metadata.json`,
and **that list breaks at every major release**. This is a recurring
obligation, not a one-off: when GNOME ships a new major, the extension has to
be checked and the list widened, or it silently stops loading.

The shipped manifest declares Shell 48, 49 and 50. Only **50.4** has been
exercised; the two older entries rest on the extension API being stable across
that range, not on a run.

That obligation is only bearable if checking is one command, so it is:

```bash
scripts/probe-gnome-extension.sh
```

It runs a **headless, throwaway** GNOME Shell — no window on your desktop, its
own dconf and data directory, your live session and its extension list left
alone — loads the extension there and asks the shell for its state. `ACTIVE`
means it loaded and `enable()` ran without throwing; anything else prints the
exception the shell recorded. Exit status follows, so it can gate a release.

The probe is known to discriminate: pointing an import at a missing module
turns `ACTIVE` into `ERROR`. A check that cannot fail would tell you nothing.

What it does **not** cover is what the thing looks like — headless has no
screen. Placement, the icon and the label still want a human eye, once.
