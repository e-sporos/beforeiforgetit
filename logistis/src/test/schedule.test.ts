import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { loadPack, resolveParameter } from '../rules/pack.js';
import { appliesTo, resolveInstances } from '../rules/schedule.js';
import { applyBrackets, parsePeriod } from '../domain/estimates.js';
import type { Bracket, Profile } from '../types.js';

const soleTrader: Profile = {
  jurisdiction: 'gr',
  legal_form: 'sole_trader',
  books: 'simple',
  vat_status: 'registered',
};

test('the greek pack loads and parses', () => {
  const { pack, holidays } = loadPack('gr');
  assert.equal(pack.id, 'gr');
  assert.equal(pack.currency, 'EUR');
  assert.ok(pack.obligations.length > 0);
  assert.ok(holidays.fixed.length > 0);
  assert.ok(holidays.movable.length > 0);
  // Dates must be normalised to strings, not left as Date objects.
  assert.equal(typeof pack.meta.last_reviewed, 'string');
});

test('obligations are matched to the profile that actually has them', () => {
  const { pack } = loadPack('gr');
  const quarterlyVat = pack.obligations.find((o) => o.id === 'gr.vat.return.quarterly')!;
  const monthlyVat = pack.obligations.find((o) => o.id === 'gr.vat.return.monthly')!;
  const vies = pack.obligations.find((o) => o.id === 'gr.vies.recapitulative')!;

  assert.equal(appliesTo(quarterlyVat, soleTrader), true);
  assert.equal(appliesTo(monthlyVat, soleTrader), false, 'single-entry books file quarterly');
  assert.equal(appliesTo(vies, soleTrader), false, 'no intra-EU flag set, so no VIES nagging');
  assert.equal(appliesTo(vies, { ...soleTrader, has_intra_eu_b2b: true }), true);
});

test('quarterly VAT resolves to the last working day of the following month', () => {
  const { pack, holidays } = loadPack('gr');
  const instances = resolveInstances({
    obligations: pack.obligations,
    profile: soleTrader,
    holidays,
    from: '2026-01-01',
    to: '2026-12-31',
    today: '2026-08-04',
    packId: 'gr',
  }).filter((i) => i.obligation_id === 'gr.vat.return.quarterly');

  assert.equal(instances.length, 4, 'four quarterly returns fall due within 2026');

  const q1 = instances.find((i) => i.period_key === '2026-Q1')!;
  assert.equal(q1.due_date, '2026-04-30', 'Q1 ends 31 Mar, due end of April');

  const q2 = instances.find((i) => i.period_key === '2026-Q2')!;
  // 31 July 2026 is a Friday and not a holiday.
  assert.equal(q2.due_date, '2026-07-31');

  const q4of2025 = resolveInstances({
    obligations: pack.obligations,
    profile: soleTrader,
    holidays,
    from: '2026-01-01',
    to: '2026-02-28',
    today: '2026-08-04',
    packId: 'gr',
  }).find((i) => i.instance_id === 'gr.vat.return.quarterly:2025-Q4');
  assert.ok(q4of2025, 'the prior-year Q4 return falls due in January and must not be dropped');
});

test('the annual income tax return lands in July of the following year', () => {
  const { pack, holidays } = loadPack('gr');
  const returns = resolveInstances({
    obligations: pack.obligations,
    profile: soleTrader,
    holidays,
    from: '2026-01-01',
    to: '2026-12-31',
    today: '2026-08-04',
    packId: 'gr',
  }).filter((i) => i.obligation_id === 'gr.income_tax.return');

  assert.equal(returns.length, 1);
  assert.equal(returns[0]!.period_key, '2025', 'the 2026 deadline covers tax year 2025');
  assert.equal(returns[0]!.due_date, '2026-07-15');
  assert.equal(returns[0]!.often_extended, true);
});

test('the e-invoicing mandate appears exactly once, on its fixed date', () => {
  const { pack, holidays } = loadPack('gr');
  const mandate = resolveInstances({
    obligations: pack.obligations,
    profile: soleTrader,
    holidays,
    from: '2026-01-01',
    to: '2027-12-31',
    today: '2026-08-04',
    packId: 'gr',
  }).filter((i) => i.obligation_id === 'gr.einvoicing.b2b_mandate');

  assert.equal(mandate.length, 1);
  assert.equal(mandate[0]!.due_date, '2026-10-01');
  assert.ok(mandate[0]!.action_required, 'a one-off mandate is useless without an action');
});

test('parameters carry provenance and go stale loudly', () => {
  const { pack } = loadPack('gr');

  const vat = resolveParameter<number>(pack, 'vat_standard_rate', '2026-06-30', '2026-08-04');
  assert.equal(vat.value, 0.24);
  assert.ok(vat.source);
  assert.equal(vat.warnings.length, 0, 'a fresh, high-confidence value warns about nothing');

  // Pretend it is well past the review date.
  const stale = resolveParameter<number>(pack, 'vat_standard_rate', '2026-06-30', '2030-01-01');
  assert.ok(stale.warnings.some((w) => w.includes('stale')), 'past review_by must warn');

  // The EFKA table is deliberately empty rather than guessed.
  const efka = resolveParameter(pack, 'efka_contribution_categories', '2026-06-30', '2026-08-04');
  assert.equal(efka.value, undefined);
  assert.ok(efka.warnings.length > 0);

  const missing = resolveParameter(pack, 'not_a_real_parameter', '2026-06-30', '2026-08-04');
  assert.equal(missing.value, undefined);
  assert.ok(missing.warnings.length > 0);
});

test('income tax brackets are applied marginally, not as a flat rate', () => {
  const { pack } = loadPack('gr');
  const scale = resolveParameter<Bracket[]>(pack, 'income_tax_scale_business', '2025-12-31', '2026-08-04');
  assert.ok(scale.value);

  // 25,000 of taxable income: 10k@9% + 10k@22% + 5k@28% = 900 + 2200 + 1400 = 4500
  assert.equal(applyBrackets(25_000, scale.value!).tax, 4500);
  // Exactly at a boundary.
  assert.equal(applyBrackets(10_000, scale.value!).tax, 900);
  // Into the top bracket: 900 + 2200 + 2800 + 3600 + 10k@44% = 9500 + 4400 = 13900
  assert.equal(applyBrackets(50_000, scale.value!).tax, 13_900);
  assert.equal(applyBrackets(0, scale.value!).tax, 0);
});

test('period keys parse into the right ranges', () => {
  assert.deepEqual(parsePeriod('2026'), { key: '2026', start: '2026-01-01', end: '2026-12-31' });
  assert.deepEqual(parsePeriod('2026-Q2'), { key: '2026-Q2', start: '2026-04-01', end: '2026-06-30' });
  assert.deepEqual(parsePeriod('2026-02'), { key: '2026-02', start: '2026-02-01', end: '2026-02-28' });
  assert.throws(() => parsePeriod('last quarter'));
  assert.throws(() => parsePeriod('2026-13'));
});
