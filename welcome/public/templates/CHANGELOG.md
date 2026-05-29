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

Examples :

  ❌ add parse_routing_spec() + pick_upstream() in routing.rs
  ✅ Route different sessions through different SOCKS5 upstreams by tagging
     each via the username — useful for multi-account scraping that needs
     per-account proxies.

  ❌ refactor: extract foo() from bar()
  ✅ (skip — internal cleanup, nothing changes for the user)

  ❌ fix bug in parser
  ✅ Quoted paths with spaces no longer corrupt the upload manifest.

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
