# Contributing

The most valuable contribution is a jurisdiction pack for a country that is not
covered yet, or a correction to one that is.

## The rule that matters more than any style guide

**If you cannot cite an official source for a number, do not add the number.**

A missing parameter produces a loud, honest failure. A guessed parameter
produces a confident wrong answer that someone plans their cash flow around for
a year. The second is much worse, and it is the failure this project exists to
prevent.

If you are unsure, add the entry anyway but mark it:

```yaml
confidence: low
needs_verification: true
```

Both flags surface to the end user through `pack_health` and every tool that
reads the value. Uncertainty that is visible is fine; uncertainty that is hidden
is not.

## Adding a jurisdiction

1. Copy `jurisdictions/gr/` to `jurisdictions/<iso-code>/`.
2. Work through `pack.yaml` top to bottom. Delete what does not apply rather
   than leaving Greek rules in place with new labels.
3. Adjust `holidays.yaml`. If your country's movable holidays derive from
   something other than Orthodox Easter, add the computation to
   `src/rules/businessDays.ts` — that is the one place jurisdiction-specific
   code is expected.
4. Add tests in `src/test/` asserting a few real due dates you can verify
   independently. The Greek tests are a template: they check that Q1 VAT lands
   on the last working day of April, that a deadline falling on a public
   holiday rolls forward, and that the tax brackets are applied marginally
   rather than as a flat rate.
5. Run `npm test`.

### What goes where

**`obligations`** — anything with a recurring deadline. Each needs an `owner`
(`accountant`, `you`, or `either`); this drives the accountability scorecard, so
think about who realistically does it, not who is legally liable.

**`parameters`** — numbers used in estimates. Always a list of dated values, so
that a filing for a past period is computed with the rate that applied then:

```yaml
values:
  - value: 0.24
    effective_from: 2021-01-01
  - value: 0.23
    effective_from: 2016-06-01
```

**`pending_changes`** — announced but not yet in force. This section is a
first-class feature, not a to-do list: it is how the agent tells a user about a
change before it bites. Move entries into `obligations` or `parameters` once
enacted, and delete them from here.

**`watch_sources`** — official pages worth polling. Prefer stable index pages
(a circulars listing, a news index) over deep links that rot. Avoid pages with
rotating content — the watcher hashes text, and a page that changes on every
load trains the user to ignore alerts.

### Schedule rules available

| `rule` | Meaning |
|---|---|
| `last_business_day_of_month` | Last working day of the month `months_after_period_end` after the period ends |
| `day_of_month` | A specific `day`, rolled forward off weekends and holidays |
| `fixed_day_in_year` | A `month`/`day`, optionally `years_after_period_end` later |
| `fixed_date` | A literal one-off `date` |

If your jurisdiction needs something else, add it to
`src/rules/schedule.ts:dueDateFor` and document it here.

## Code

- TypeScript, strict mode, `npm run typecheck` clean.
- No new runtime dependencies without a good reason. The dependency list is
  short on purpose: this software touches someone's financial records.
- Estimator functions return `assumptions` and `warnings` alongside their
  numbers. Keep it that way — a bare number is a bug in this codebase.
- Dates are ISO `YYYY-MM-DD` strings, never `Date` objects. A `Date` carries a
  timezone that turns "due on the 31st" into "due on the 30th" for anyone
  running the server from a different offset.

## Reporting a wrong rule

Open an issue with the jurisdiction, the obligation or parameter id, what the
correct value is, and a link to the official source. Rules going stale is the
expected failure mode of this project, not an unusual one — reports are welcome
and never a nuisance.

## Scope

Logistis prepares, reminds, records and checks. It does not file returns,
authenticate to tax authority portals, or move money. Pull requests that add
those capabilities will be declined: the trust and liability model of this
project depends on a human being the one who submits.
