<!--
intent: a Keep-a-Changelog (https://keepachangelog.com/en/1.1.0/) formatted
changelog. Group entries by released version + an [Unreleased] section at
the top for landed-but-not-tagged work. Each section uses the canonical
headings (Added / Changed / Deprecated / Removed / Fixed / Security) — drop
the headings that have no entries this release rather than leaving them
empty. Version numbers follow SemVer (https://semver.org/). Dates are
ISO-8601 (YYYY-MM-DD).

WRITING STYLE — lead with the USER-FACING INTENTION, not the implementation :

- One entry = one meaningful change a user / integrator / operator would
  notice. If it changes nothing observable from outside the code, it
  doesn't belong here (use the commit log for that).
- Plain language. Avoid commit-message phrasing, file paths, function or
  pseudo-code, and "refactor X" entries that hide what the user gets.
- Lead with the "what + why for whom" ; the implementation is a footnote
  at best, usually skipped.
- ONE-LINE entries by default. Multi-paragraph entries are only justified
  for a major change a user genuinely needs to read in full ; tiny tweaks
  and follow-ups should fit on a single bullet (or be merged into a
  neighbour). If your section looks like the commit log paraphrased, cut.
- DO NOT cite internal issue tracker IDs (`#NNN`, `JIRA-123`, etc.) when
  that tracker is not externally browsable — they're noise without a
  link. Internal-only context belongs in the commit log + ticket thread,
  not the user-facing CHANGELOG. Reference public refs (GitHub PRs,
  upstream issues) only.

VERSIONING — SemVer (https://semver.org/) :

- Any new flag / command / endpoint / behaviour-toggle is **MINOR** (Y+1).
  Even small ones. If your section has an `### Added`, the bump is at
  least MINOR.
- Pure bug fixes (`### Fixed`) → **PATCH** (Z+1).
- Breaking changes (removed flag, renamed endpoint, response shape that
  loses a field) → **MAJOR** (X+1).
- Pre-1.0 stays loose, but the spirit holds: a PATCH bump should NOT
  contain feat() commits.

Examples :

  ❌ add parse_routing_spec() + pick_upstream() in routing.rs
  ✅ Route different sessions through different SOCKS5 upstreams by tagging
     each via the username — useful for multi-account scraping that needs
     per-account proxies.

  ❌ refactor: extract foo() from bar()
  ✅ (skip — internal cleanup, nothing changes for the user)

  ❌ fix bug in parser
  ✅ Quoted paths with spaces no longer corrupt the upload manifest.

  ❌ Visual cue for the read-transition dwell (#596). When you open an unread
     ticket, an envelope icon appears next to the title and flickers
     green → muted gray over the 2-second auto-mark-read window — a
     "dying lamp" animation so the moderation moment is visible.
  ✅ Unread tickets now show a brief envelope flicker while they're being
     marked as read, so the transition is visible instead of silent.

Keep the header line below in the rendered file — it's the persistent
reminder for future editors (the intent block above is stripped when this
template ships, so the body has to carry the convention).
-->

# Changelog

All notable changes to this project will be documented in this file.

> This is a curated, human-readable record — **not a commit log**. Each
> entry says *what changed and why it matters to a user*, in plain
> language, not *how* it was implemented. Skip internal refactors.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- {entry — what a user can now do that they couldn't before, in plain
  language. Avoid file paths / function names / pseudo-code.}

### Changed

- {entry — what's different from the user's perspective.}

### Fixed

- {entry — what broken behaviour is now correct.}

## [0.1.0] - {YYYY-MM-DD}

### Added

- Initial release.
