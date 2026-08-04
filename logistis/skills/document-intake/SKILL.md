---
name: document-intake
description: Sweep email and cloud storage for invoices, receipts and accountant correspondence, extract the figures, and record them in Logistis. Use when the user asks to catch up their books, process receipts, find missing documents before a VAT deadline, or check what their accountant has actually sent them.
---

# Document intake

Getting documents into the ledger is the boring half of bookkeeping and the
half that actually determines whether the numbers are right. A deduction you
never recorded is a deduction you never get.

This skill assumes you have access to the user's email and file storage through
whatever connectors they have set up (Gmail, Google Drive, a local folder). The
Logistis MCP server does not fetch documents itself — you do the reading, it
does the recording.

## Before you start

Ask what window to cover, or infer it from the deadline in play. For a VAT
deadline, the window is the quarter being filed, plus a couple of weeks either
side to catch documents that arrived late or were dated early.

Run `expense_list` and `invoice_list` for the period first. You are looking for
gaps, not starting from zero, and re-recording an expense that is already in the
ledger silently doubles a deduction.

## Finding things

Search for the shapes these documents take, not just the word "invoice":

- Supplier receipts: `invoice`, `receipt`, `τιμολόγιο`, `απόδειξη`, `payment
  confirmation`, `your subscription`, plus known suppliers (Figma, Adobe, AWS,
  hosting, coworking, phone, accountant's own fees).
- Client-side documents: anything with the client's name plus `ΜΑΡΚ`,
  `παρακράτηση`, `βεβαίωση αποδοχών`.
- Accountant correspondence: mail from their address, and anything mentioning
  `ΦΠΑ`, `Ε3`, `εκκαθαριστικό`, `ειδοποιητήριο`, `πρόστιμο`.

Attachments matter more than message bodies. A PDF attached to a one-line email
is the actual document.

## Extracting figures

For each document, pull: supplier, date, **net amount**, VAT amount, VAT rate,
document number.

The trap: many invoices show only the gross total. Logistis wants the **net**
(pre-VAT) amount. If you have gross and a rate, net = gross / (1 + rate). If you
cannot determine the split confidently, say so and ask — do not guess, because a
wrong split lands in both the VAT return and the income tax estimate.

Watch for:
- **Non-Greek suppliers.** A US SaaS invoice usually carries no Greek VAT, so
  there is no input VAT to deduct. EU suppliers billing under reverse charge
  have their own treatment — flag these for the accountant rather than
  inventing a rate.
- **Mixed personal/business items.** Phone, internet, a laptop used for both.
  Ask the user for the business proportion and set `vat_deductible_ratio`.
  Defaulting to 1 quietly overstates their deduction.
- **Duplicates.** A receipt emailed and also saved to Drive is one expense.

## Recording

Call `expense_record` per document, and **always** set `document_location` to
where the file actually lives. An expense whose document cannot be produced on
request is not deductible under audit — this field is the difference between a
number and a defensible number.

For client invoices, `invoice_create`. Set `client_country` and
`client_vat_number`: they drive the withholding-tax and reverse-charge logic. If
the invoice already has a ΜΑΡΚ from myDATA, record it.

## Reporting back

Summarise as: how many documents found, how many recorded, total net and input
VAT added, and — most usefully — **what looks missing**. A quarter with no
phone bill, no accountant fee, or no hosting invoice is a quarter with lost
deductions. Say which recurring suppliers you expected and did not find.

Then re-run `vat_estimate` for the period so the user sees the effect.

## Handling accountant correspondence

When you find mail from the accountant, log the substantive ones with
`handoff_log` (`direction: received`). If it answers something the user chased,
close it with `handoff_respond`.

If you find a penalty notice, a deadline extension, or a rule change, do not
just file it — surface it immediately and explain what it means. That is the
whole reason this project exists.

## What not to do

Do not send email, reply to the accountant, or forward documents anywhere
without the user asking. Read and record; let them decide what leaves their
account.
