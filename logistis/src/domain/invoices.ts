/**
 * Invoice and expense construction.
 *
 * The non-obvious part is withholding tax. When a Greek business pays your
 * invoice, it keeps 20% of your net fee and remits it to AADE against your
 * income tax. So the money that reaches your bank is *not* your invoice total,
 * and the difference is not a loss — it is tax you have already paid. Track it
 * per invoice, or you will hand the state an interest-free loan and never
 * claim it back at year end.
 */

import type { Expense, Invoice, IsoDate } from '../types.js';
import { newId } from '../store.js';
import { round2 } from './money.js';

export interface InvoiceInput {
  client: string;
  net_amount: number;
  issue_date: IsoDate;
  number?: string;
  client_vat_number?: string;
  client_country?: string;
  due_date?: IsoDate;
  description?: string;
  vat_rate: number;
  /** Intra-EU B2B supply: no Greek VAT charged, customer self-accounts. */
  reverse_charge?: boolean;
  /** Greek business clients normally withhold; consumers and foreign clients do not. */
  withholding_rate?: number;
  mydata_mark?: string;
  notes?: string;
}

export function buildInvoice(input: InvoiceInput): Invoice {
  if (!(input.net_amount > 0)) {
    throw new Error('net_amount must be a positive number (the amount before VAT).');
  }

  const reverseCharge = Boolean(input.reverse_charge);
  const vatRate = reverseCharge ? 0 : input.vat_rate;
  const vatAmount = round2(input.net_amount * vatRate);
  const withholdingAmount = round2(input.net_amount * (input.withholding_rate ?? 0));

  return {
    id: newId('inv'),
    number: input.number,
    client: input.client,
    client_vat_number: input.client_vat_number,
    client_country: input.client_country,
    issue_date: input.issue_date,
    due_date: input.due_date,
    description: input.description,
    net_amount: round2(input.net_amount),
    vat_rate: vatRate,
    vat_amount: vatAmount,
    withholding_amount: withholdingAmount,
    payable_amount: round2(input.net_amount + vatAmount - withholdingAmount),
    status: 'issued',
    reverse_charge: reverseCharge,
    mydata_mark: input.mydata_mark,
    notes: input.notes,
    created_at: new Date().toISOString(),
  };
}

export interface ExpenseInput {
  supplier: string;
  date: IsoDate;
  /** Amount before VAT. */
  net_amount: number;
  vat_rate: number;
  /** 0–1. Use less than 1 for mixed personal/business items such as a phone bill. */
  vat_deductible_ratio?: number;
  description?: string;
  category?: string;
  document_ref?: string;
  document_location?: string;
}

export function buildExpense(input: ExpenseInput): Expense {
  const ratio = input.vat_deductible_ratio ?? 1;
  if (ratio < 0 || ratio > 1) throw new Error('vat_deductible_ratio must be between 0 and 1.');
  if (!(input.net_amount > 0)) throw new Error('net_amount must be a positive number.');

  return {
    id: newId('exp'),
    supplier: input.supplier,
    date: input.date,
    description: input.description,
    net_amount: round2(input.net_amount),
    vat_rate: input.vat_rate,
    vat_amount: round2(input.net_amount * input.vat_rate),
    vat_deductible_ratio: ratio,
    category: input.category,
    document_ref: input.document_ref,
    document_location: input.document_location,
    created_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Receivables
// ---------------------------------------------------------------------------

export interface AgingBucket {
  label: string;
  count: number;
  total: number;
  invoices: { id: string; number?: string; client: string; due_date?: IsoDate; amount: number; days_overdue: number }[];
}

/**
 * Unpaid invoices bucketed by how late they are.
 *
 * Late payment is a cash-flow problem, but it is also a tax problem: in Greece
 * you generally owe the VAT on an invoice for the period in which it was
 * issued, whether or not the client has paid you. An unpaid invoice can
 * therefore cost you money before it earns you any.
 */
export function agingReport(all: Invoice[], today: IsoDate, daysBetween: (a: IsoDate, b: IsoDate) => number): AgingBucket[] {
  const buckets: AgingBucket[] = [
    { label: 'not yet due', count: 0, total: 0, invoices: [] },
    { label: '1-30 days overdue', count: 0, total: 0, invoices: [] },
    { label: '31-60 days overdue', count: 0, total: 0, invoices: [] },
    { label: '61-90 days overdue', count: 0, total: 0, invoices: [] },
    { label: '90+ days overdue', count: 0, total: 0, invoices: [] },
  ];

  const pick = (daysOverdue: number): AgingBucket => {
    if (daysOverdue <= 0) return buckets[0]!;
    if (daysOverdue <= 30) return buckets[1]!;
    if (daysOverdue <= 60) return buckets[2]!;
    if (daysOverdue <= 90) return buckets[3]!;
    return buckets[4]!;
  };

  for (const invoice of all) {
    if (invoice.status === 'paid' || invoice.status === 'cancelled' || invoice.status === 'draft') continue;
    const reference = invoice.due_date ?? invoice.issue_date;
    const daysOverdue = daysBetween(reference, today);
    const bucket = pick(daysOverdue);
    bucket.count += 1;
    bucket.total = round2(bucket.total + invoice.payable_amount);
    bucket.invoices.push({
      id: invoice.id,
      number: invoice.number,
      client: invoice.client,
      due_date: invoice.due_date,
      amount: invoice.payable_amount,
      days_overdue: Math.max(0, daysOverdue),
    });
  }

  return buckets.filter((bucket) => bucket.count > 0);
}
