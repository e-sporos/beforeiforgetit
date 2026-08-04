/**
 * VAT and income tax estimation.
 *
 * Every function here returns its `assumptions` and `warnings` alongside the
 * number. That is not decoration — it is the contract. An estimate presented
 * without the assumptions that produced it is how people end up planning
 * around a figure that stopped being true in January.
 *
 * These are estimates for cash planning and for sanity-checking what your
 * accountant tells you. They are not filings.
 */

import type { Bracket, Expense, Invoice, IsoDate, JurisdictionPack, Profile } from '../types.js';
import { resolveParameter } from '../rules/pack.js';
import { lastDayOfMonth, toIso } from '../rules/businessDays.js';
import { round2, sum } from './money.js';

export interface Period {
  key: string;
  start: IsoDate;
  end: IsoDate;
}

/** Accepts `2026`, `2026-06` or `2026-Q2`. */
export function parsePeriod(key: string): Period {
  const trimmed = key.trim().toUpperCase();

  let match = /^(\d{4})$/.exec(trimmed);
  if (match) {
    const y = Number(match[1]);
    return { key: trimmed, start: toIso({ y, m: 1, d: 1 }), end: toIso({ y, m: 12, d: 31 }) };
  }

  match = /^(\d{4})-Q([1-4])$/.exec(trimmed);
  if (match) {
    const y = Number(match[1]);
    const q = Number(match[2]);
    const startM = (q - 1) * 3 + 1;
    const endM = startM + 2;
    return {
      key: trimmed,
      start: toIso({ y, m: startM, d: 1 }),
      end: toIso({ y, m: endM, d: lastDayOfMonth(y, endM) }),
    };
  }

  match = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]);
    if (m < 1 || m > 12) throw new Error(`Month out of range in period "${key}".`);
    return { key: trimmed, start: toIso({ y, m, d: 1 }), end: toIso({ y, m, d: lastDayOfMonth(y, m) }) };
  }

  throw new Error(`Cannot parse period "${key}". Use a year (2026), a quarter (2026-Q2), or a month (2026-06).`);
}

const inPeriod = (date: IsoDate, period: Period) => date >= period.start && date <= period.end;
const counts = (invoice: Invoice) => invoice.status !== 'cancelled' && invoice.status !== 'draft';

// ---------------------------------------------------------------------------
// VAT
// ---------------------------------------------------------------------------

export interface VatEstimate {
  period: Period;
  output_vat: number;
  input_vat: number;
  /** Positive means you owe; negative means a credit to carry forward. */
  net_payable: number;
  invoice_count: number;
  expense_count: number;
  reverse_charge_net: number;
  assumptions: string[];
  warnings: string[];
}

export function estimateVat(args: {
  periodKey: string;
  invoices: Invoice[];
  expenses: Expense[];
  profile: Profile;
}): VatEstimate {
  const period = parsePeriod(args.periodKey);
  const warnings: string[] = [];

  const periodInvoices = args.invoices.filter((i) => counts(i) && inPeriod(i.issue_date, period));
  const periodExpenses = args.expenses.filter((e) => inPeriod(e.date, period));

  const outputVat = sum(periodInvoices.map((i) => i.vat_amount));
  const inputVat = sum(periodExpenses.map((e) => round2(e.vat_amount * e.vat_deductible_ratio)));
  const reverseChargeNet = sum(periodInvoices.filter((i) => i.reverse_charge).map((i) => i.net_amount));

  if (args.profile.vat_status !== 'registered') {
    warnings.push(
      `Your profile says vat_status is "${args.profile.vat_status}", so a VAT return may not apply to you at all. ` +
        `This figure is computed regardless — confirm your regime before acting on it.`,
    );
  }
  if (periodInvoices.length === 0) {
    warnings.push('No invoices recorded in this period. If you issued any, they are missing from the ledger and this figure is wrong.');
  }
  if (periodExpenses.length === 0) {
    warnings.push('No expenses recorded in this period, so no input VAT is being deducted. Deductions you never record are deductions you never get.');
  }

  const expensesWithoutDocs = periodExpenses.filter((e) => !e.document_ref && !e.document_location).length;
  if (expensesWithoutDocs > 0) {
    warnings.push(
      `${expensesWithoutDocs} expense(s) in this period have no document reference. Input VAT without a valid invoice is not deductible if you are audited.`,
    );
  }

  return {
    period,
    output_vat: outputVat,
    input_vat: inputVat,
    net_payable: round2(outputVat - inputVat),
    invoice_count: periodInvoices.length,
    expense_count: periodExpenses.length,
    reverse_charge_net: reverseChargeNet,
    assumptions: [
      'VAT is accounted for on the invoice date, not the payment date — an unpaid invoice still generates VAT you must remit.',
      'Input VAT is reduced by each expense\'s vat_deductible_ratio.',
      'Reverse-charged intra-EU B2B supplies carry no output VAT here but must still be reported on the VIES statement.',
    ],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Income tax
// ---------------------------------------------------------------------------

export function applyBrackets(taxable: number, brackets: Bracket[]): { tax: number; breakdown: string[] } {
  const breakdown: string[] = [];
  let remaining = Math.max(0, taxable);
  let previousCeiling = 0;
  let tax = 0;

  for (const bracket of brackets) {
    if (remaining <= 0) break;
    const ceiling = bracket.up_to ?? Infinity;
    const width = ceiling - previousCeiling;
    const slice = Math.min(remaining, width);
    const sliceTax = round2(slice * bracket.rate);
    tax = round2(tax + sliceTax);
    breakdown.push(
      `${round2(slice).toFixed(2)} @ ${(bracket.rate * 100).toFixed(0)}% = ${sliceTax.toFixed(2)}`,
    );
    remaining = round2(remaining - slice);
    previousCeiling = ceiling;
  }

  return { tax, breakdown };
}

export interface IncomeTaxEstimate {
  year: number;
  revenue: number;
  expenses: number;
  efka_contributions: number;
  declared_profit: number;
  imputed_floor?: number;
  taxable_income: number;
  taxable_basis: 'declared profit' | 'imputed minimum income';
  tax_before_credits: number;
  bracket_breakdown: string[];
  prepayment_next_year: number;
  tax_already_withheld: number;
  prior_year_prepayment_credit: number;
  estimated_balance_due: number;
  /** What to hold back from every euro that comes in, to cover all of this. */
  suggested_set_aside_ratio: number;
  assumptions: string[];
  warnings: string[];
  sources: string[];
}

export function estimateIncomeTax(args: {
  year: number;
  invoices: Invoice[];
  expenses: Expense[];
  profile: Profile;
  pack: JurisdictionPack;
  today: IsoDate;
  priorYearPrepaymentCredit?: number;
}): IncomeTaxEstimate {
  const { year, profile, pack, today } = args;
  const period = parsePeriod(String(year));
  const warnings: string[] = [];
  const sources: string[] = [];

  const yearInvoices = args.invoices.filter((i) => counts(i) && inPeriod(i.issue_date, period));
  const yearExpenses = args.expenses.filter((e) => inPeriod(e.date, period));

  const revenue = sum(yearInvoices.map((i) => i.net_amount));
  const expenseTotal = sum(yearExpenses.map((e) => e.net_amount));

  // e-EFKA contributions are a deductible business expense, and for most
  // one-person businesses they are one of the largest.
  let efka = 0;
  if (profile.efka_monthly_amount && profile.efka_monthly_amount > 0) {
    efka = round2(profile.efka_monthly_amount * 12);
    if (profile.efka_amount_verified_on && profile.efka_amount_verified_on < `${year}-01-01`) {
      warnings.push(
        `Your e-EFKA monthly amount was last verified on ${profile.efka_amount_verified_on}, before ${year} began. ` +
          `Contribution amounts change every January — check your latest ειδοποιητήριο and update the profile.`,
      );
    }
  } else {
    warnings.push(
      'No e-EFKA monthly amount is set in your profile, so social security contributions are treated as zero. ' +
        'They are deductible and substantial, so this materially overstates your taxable income. ' +
        'Copy the figure from your e-EFKA notice into the profile.',
    );
  }

  const declaredProfit = round2(revenue - expenseTotal - efka);

  let taxableIncome = declaredProfit;
  let basis: IncomeTaxEstimate['taxable_basis'] = 'declared profit';
  if (profile.imputed_income_floor && profile.imputed_income_floor > declaredProfit) {
    taxableIncome = profile.imputed_income_floor;
    basis = 'imputed minimum income';
    warnings.push(
      `The imputed minimum income floor (${profile.imputed_income_floor}) exceeds your declared profit (${declaredProfit}), ` +
        `so you would be taxed on the floor. This is the single most common unpleasant surprise for Greek freelancers.`,
    );
  } else if (!profile.imputed_income_floor) {
    warnings.push(
      'No imputed_income_floor is set in your profile. Greek self-employed taxpayers are generally taxed on a minimum ' +
        'imputed income if it exceeds declared profit. Ask your accountant for your figure and record it, or this ' +
        'estimate may be far too low.',
    );
  }

  const scale = resolveParameter<Bracket[]>(pack, 'income_tax_scale_business', `${year}-12-31`, today);
  warnings.push(...scale.warnings);
  if (scale.source) sources.push(scale.source);

  let tax = 0;
  let breakdown: string[] = [];
  if (scale.value) {
    const applied = applyBrackets(taxableIncome, scale.value);
    tax = applied.tax;
    breakdown = applied.breakdown;
  } else {
    warnings.push('No income tax scale available for this year — the tax figure below is zero and meaningless.');
  }

  const prepaymentRate = resolveParameter<number>(pack, 'income_tax_prepayment_rate', `${year}-12-31`, today);
  warnings.push(...prepaymentRate.warnings);
  if (prepaymentRate.source) sources.push(prepaymentRate.source);
  const prepayment = round2(tax * (prepaymentRate.value ?? 0));

  const withheld = sum(yearInvoices.map((i) => i.withholding_amount));
  const priorCredit = round2(args.priorYearPrepaymentCredit ?? 0);
  if (!args.priorYearPrepaymentCredit) {
    warnings.push(
      'No prior-year prepayment credit was supplied, so this estimate does not subtract the prepayment you already ' +
        'made last year. Your actual bill will usually be lower. The figure is on last year\'s εκκαθαριστικό.',
    );
  }

  const balance = round2(tax + prepayment - withheld - priorCredit);
  const setAsideRatio = revenue > 0 ? round2(Math.max(0, tax + prepayment + efka) / revenue) : 0;

  return {
    year,
    revenue,
    expenses: expenseTotal,
    efka_contributions: efka,
    declared_profit: declaredProfit,
    imputed_floor: profile.imputed_income_floor,
    taxable_income: taxableIncome,
    taxable_basis: basis,
    tax_before_credits: tax,
    bracket_breakdown: breakdown,
    prepayment_next_year: prepayment,
    tax_already_withheld: withheld,
    prior_year_prepayment_credit: priorCredit,
    estimated_balance_due: balance,
    suggested_set_aside_ratio: setAsideRatio,
    assumptions: [
      'Income is recognised on the invoice date.',
      'All recorded expenses are treated as fully deductible for income tax. Entertainment, mixed-use and capital items may not be — your accountant decides.',
      'e-EFKA contributions are deducted as a business expense.',
      'The trade fee (τέλος επιτηδεύματος) is treated as abolished for natural persons from tax year 2024.',
      'No personal allowances, family relief, or non-business income are modelled. This estimates the business side only.',
    ],
    warnings,
    sources: [...new Set(sources)],
  };
}
