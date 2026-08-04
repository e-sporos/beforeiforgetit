# Logistis

An MCP server that gives an AI agent what it needs to act as bookkeeper for a
one-person business: the statutory calendar, the books, the arithmetic, and —
the part most tools skip — **the provenance of every number it reports**.

Ships with a Greek jurisdiction pack (ΑΑΔΕ / e-ΕΦΚΑ). The rules live in YAML,
not in code, so adding another country means writing a file, not a fork.

> **Not tax advice, and not a replacement for an accountant.** Logistis does not
> file anything. It exists so that nothing gets silently missed, and so you can
> check what you are told.

## Why this exists

It was built by a freelance designer whose accountants never mentioned rule
changes, forgot filings, and generated penalties that were entirely avoidable.
The design follows directly from those three failures:

| Failure | What Logistis does about it |
|---|---|
| "Nobody told me the rules changed" | A watcher that polls official sources and reports what moved, plus a hand-maintained `pending_changes` list of announced-but-not-yet-in-force changes |
| "They forgot to file it" | A deadline engine that resolves real due dates — weekends and Greek public holidays included — and escalates as they approach |
| "I only found out when the penalty arrived" | Every obligation has an owner and an audit record; the accountant scorecard turns a vague grievance into a dated list |

The rule that shapes everything else: **a stale number must fail loudly, never
silently.** Every parameter carries a source URL, a `verified_on` date and a
`review_by` date. Past its review date, every tool that touches it returns a
warning. The Greek pack deliberately ships **no** e-EFKA contribution table,
because a guessed one would quietly corrupt a year of cash-flow planning —
you copy your real figure from your own notice instead.

## Install

```bash
git clone https://github.com/e-sporos/logistis.git
cd logistis
npm install
npm run build
npm test
```

Register it with your MCP client. For Claude Code:

```bash
claude mcp add logistis -- node /absolute/path/to/logistis/dist/index.js
```

Or in a client config file:

```json
{
  "mcpServers": {
    "logistis": {
      "command": "node",
      "args": ["/absolute/path/to/logistis/dist/index.js"]
    }
  }
}
```

Copy `skills/` into your agent's skills directory so it knows how to use the
tools well. The server supplies capability; the skills supply judgement.

## Your data

Plain JSON in `~/.logistis`, owner-readable only. Override with
`LOGISTIS_DATA_DIR`. Nothing is uploaded anywhere, and the only network calls
the server ever makes are `rules_check_sources` fetching the public government
pages listed in your jurisdiction pack.

These are your books — keep the directory in a private backup or a private git
repo. `.gitignore` already excludes `data/` and `.logistis/` so you cannot
commit them into this repo by accident.

## First run

```
profile_set   jurisdiction=gr, legal_form=sole_trader, books=simple,
              vat_status=registered, has_intra_eu_b2b=true
```

Then fill in the two figures that only you can supply:

- `efka_monthly_amount` — from your e-ΕΦΚΑ ειδοποιητήριο.
- `imputed_income_floor` — your τεκμαρτό figure. Ask your accountant.

Without these, income tax estimates are wrong in the direction that hurts:
too low.

`tracking_since` defaults to today, so the tool does not retroactively mark
periods it was never watching as "missed". Back-fill history deliberately with
`obligation_record` if you want it.

## Tools

**Setup** — `profile_get`, `profile_set`

**Deadlines** — `obligations_upcoming`, `obligations_calendar`,
`obligation_record`, `compliance_report`

**Accountability** — `accountant_scorecard`, `handoff_log`, `handoff_respond`,
`handoff_list`

**Books** — `invoice_create`, `invoice_mark_paid`, `invoice_list`,
`receivables_aging`, `expense_record`, `expense_list`

**Estimates** — `vat_estimate`, `income_tax_estimate`

**Rules** — `rules_parameter`, `rules_pending_changes`, `rules_check_sources`,
`rules_change_assess`, `rules_changes_list`, `pack_health`

## What the Greek pack covers

Quarterly and monthly ΦΠΑ returns · VIES recapitulative statements · OSS ·
e-ΕΦΚΑ contributions · the annual Ε1/Ε3 return and its first installment ·
myDATA transmission · the mandatory B2B e-invoicing rollout · standard VAT rate ·
income tax brackets · prepayment rate · withholding tax on professional fees ·
the abolition of τέλος επιτηδεύματος for natural persons.

Due dates account for weekends, fixed Greek public holidays, and the movable
Orthodox Easter feasts (Καθαρά Δευτέρα, Μεγάλη Παρασκευή, Δευτέρα του Πάσχα,
Αγίου Πνεύματος), computed rather than hardcoded per year.

Two things the pack refuses to compute, on purpose: e-ΕΦΚΑ contribution amounts
and your imputed income floor. Both change often and depend on your specific
circumstances. Guessing them would produce confident, wrong numbers — which is
worse than no number at all.

### Known limitations

- Reduced and island VAT rates are not modelled.
- Personal allowances, family relief and non-business income are not modelled;
  income tax estimates cover the business side only.
- The announced 2026 income tax reform is **not** encoded. Estimates for tax
  year 2026 onward use the older scale and warn accordingly.
- Any date can be moved by ministerial decision. Deadlines marked
  `often_extended` frequently are — but never plan around an unannounced one.

## Adding your country

Copy `jurisdictions/gr/`, work through it, and open a pull request. The schedule
engine, estimators and provenance machinery are jurisdiction-agnostic; you
should only need to write YAML. See [CONTRIBUTING.md](CONTRIBUTING.md).

The one rule: **if you cannot cite an official source for a number, do not add
the number.** Mark anything uncertain `confidence: low` and
`needs_verification: true` — the tools surface those to the user rather than
presenting them as fact.

## Licence

MIT.
