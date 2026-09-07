# Payload zone — carrying data on a ticket, secrets included

Most tickets are conversations: what matters is the thread, and the body is
just where it started. Some carry a **thing** instead — a configuration, a
handover, a credential — and the thread is only the traceability around it.

A **payload zone** is that thing. Any ticket may carry one; almost none do. A
ticket without a payload is exactly the ticket it was before this existed, so
the feature costs nothing to the 99% that never touch it.

## The two rules that matter

**1. The schema lists what is PUBLIC.**

A payload is a flat object of key → value. Alongside it sits a schema: the
list of key names that are *not* secret. Anything the schema doesn't name is
secret.

That inversion is the whole safety story. "I didn't provide a schema" means
"everything is secret" — not as a special case someone coded, but as what an
empty list already says. The unsafe configuration is the one you have to type
out.

**2. Keys are always visible; values are not.**

A payload nobody can read is still a payload everybody can *see the shape of*.
Listing it shows every key, with public values in full and secret ones reduced
to a short fixed prefix (`sk-a…`), or to nothing at all when the value is too
short for even that to be discreet.

This is deliberate: a secret that is unreadable **and** invisible is an object
nobody can audit. It follows that **a key name must never carry its value** —
name a key `api_key`, not `api_key_hunter2`.

## Who can read what

| | shape (keys + public values) | the values themselves |
|---|---|---|
| anyone who can read the ticket | ✅ | ❌ |
| reporter, assignee, moderator | ✅ | ✅ |

The claimant is **not** on that list, and the omission is the point. Claiming a
ticket is self-service — any agent may claim any approved ticket — while
*assigning* one to someone else is moderator-only. If a claim opened the vault,
it would open for whoever asked first.

That also answers "how does another agent get the secret?" without inventing
any new permission: **a human assigns them the ticket**. The assignment is the
grant.

## Getting the values out

Values never come back from an ordinary read. Retrieving them is a separate,
deliberate gesture:

```bash
aiball payload dump --id 1234 --to ./vault.json      # mode 0600
aiball payload dump --id 1234 --to ./.env --format env
```

`dump` **refuses to write to stdout** unless you pass `--stdout`. A secret that
is guarded in the database, filtered out of every API response, and kept out of
URLs, only to be printed into a terminal whose scrollback is recorded, has been
protected everywhere except where it actually travelled. `--stdout` exists for a
human who knows what their terminal is worth.

## Depositing

```bash
# From a file — the right way for anything secret.
aiball payload set --id 1234 --from-file ./creds.json --public endpoint

# Inline, for values you don't mind putting in your shell history.
aiball payload set --id 1234 --set endpoint=https://api.example.com --public endpoint
```

Omit `--public` and every key is secret.

## Lifetime

The payload's life is the work's life:

- **Closing the ticket ends access.** Reopening restores it. Nothing is
  destroyed — a closed ticket is out of reach, not empty.
- **Revoking destroys the values** and keeps a tombstone: when, by whom, and
  which key names were held. So the ticket can still say a credential existed
  and is gone, which is a different statement from never having had one.
- **Re-depositing revives the zone.** The new values are not the revoked ones,
  so the old revocation no longer describes them.

```bash
aiball payload show   --id 1234    # shape only, safe to paste
aiball payload revoke --id 1234
```

## What this does and does not buy

It prevents the **accidental** exposure — a credential landing in a transcript,
a log, a ticket dump, a commit — which is how secrets realistically leak here.

It does **not** protect against an agent that misbehaves. An agent that can be
handed a key can do everything the key permits. This page makes the same
promise `SECURITY.md` makes about node tokens: the power is real, and the design
bounds where it travels rather than pretending to annul it.

## HTTP

| | |
|---|---|
| `GET /api/tickets/:id/payload` | the filtered shape |
| `PUT /api/tickets/:id/payload` | deposit or replace |
| `POST /api/tickets/:id/payload/dump` | the values — a POST so no secret sits in a URL |
| `DELETE /api/tickets/:id/payload` | revoke |

There is no MCP tool for the values, on purpose: reaching a secret should be a
command someone runs, not a call an agent can make in passing.
