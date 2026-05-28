<!--
intent: a starter CONTRIBUTING that covers the four questions a
prospective contributor lands on the project asking:
  - how do I report a bug?
  - how do I ask for help?
  - how do I send a PR?
  - what's the code style / what tests should I run?

Adapt every section to the project's actual workflow. If something
doesn't apply (e.g. no test suite), drop the section rather than
leaving an empty heading.
-->

# Contributing

Thanks for your interest in {project-name}!

## Reporting bugs

Open an issue on the project's tracker with:

- What you tried to do.
- What you expected to happen.
- What actually happened (paste error messages / unexpected output).
- Your environment ({language/runtime} version, OS, relevant
  dependency versions).

A short reproducible snippet is worth pages of prose.

## Getting help

For usage questions (vs bug reports), {link to discussions / forum /
chat — or, if none, point to the issue tracker and ask people to
tag with `question`}.

## Sending a pull request

1. Fork + branch off `main` (one feature per branch).
2. Make the change. Keep diffs focused — small PRs review fast.
3. Add or update tests as needed; the existing suite must stay
   green ({test command}).
4. Match the project's code style ({formatter / linter command}).
5. Open the PR. Describe the **what** and the **why**; mechanical
   diff details belong in the commit messages, not the PR body.

## Commit messages

{If the project uses Conventional Commits / a specific format,
state it here. Otherwise: keep the subject line ≤ 72 chars,
imperative mood, followed by a blank line + a body that explains
the why.}

## Code of conduct

{If the project has a CODE_OF_CONDUCT.md, link it. Otherwise: be
kind and assume good faith.}
