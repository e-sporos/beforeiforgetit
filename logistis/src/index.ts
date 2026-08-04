#!/usr/bin/env node
/**
 * Logistis MCP server.
 *
 * Exposes a one-person business's books, statutory calendar and rule sources
 * as tools an agent can use. The agent supplies the judgement and the language;
 * this server supplies the arithmetic, the dates, and — importantly — the
 * provenance of every number it hands back.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadPack, packHealth, resolveParameter } from './rules/pack.js';
import { resolveInstances } from './rules/schedule.js';
import { addDays, daysBetween, todayInZone } from './rules/businessDays.js';
import {
  changes,
  expenses as expenseStore,
  filings,
  handoffs as handoffStore,
  invoices as invoiceStore,
  newId,
  readProfile,
  requireProfile,
  writeProfile,
} from './store.js';
import { agingReport, buildExpense, buildInvoice } from './domain/invoices.js';
import { estimateIncomeTax, estimateVat } from './domain/estimates.js';
import { buildAccountantScorecard, buildComplianceReport } from './domain/compliance.js';
import { checkAll } from './watch/sources.js';
import type { Bracket, FilingRecord, Profile } from './types.js';

const server = new McpServer(
  { name: 'logistis', version: '0.1.0' },
  {
    instructions:
      'Bookkeeping and statutory-deadline tools for a small business. Every estimate returned by this ' +
      'server carries `assumptions` and `warnings` — surface them to the user rather than reporting the ' +
      'bare number. Nothing here is a filing or tax advice; it exists to make sure obligations are not ' +
      'missed and to let the user check what their accountant tells them.',
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** Wraps a handler so thrown errors become tool errors rather than crashing the server. */
function handler<T>(fn: (args: T) => unknown | Promise<unknown>) {
  return async (args: T) => {
    try {
      return ok(await fn(args));
    } catch (error) {
      return fail(`${(error as Error).message}`);
    }
  };
}

function context() {
  const profile = requireProfile();
  const { pack, holidays } = loadPack(profile.jurisdiction);
  const today = todayInZone(pack.timezone ?? 'Europe/Athens');
  return { profile, pack, holidays, today };
}

function instancesBetween(from: string, to: string) {
  const { profile, pack, holidays, today } = context();
  return {
    today,
    pack,
    profile,
    instances: resolveInstances({
      obligations: pack.obligations ?? [],
      profile,
      holidays,
      from,
      to,
      today,
      packId: pack.id,
    }),
  };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

server.registerTool(
  'profile_get',
  {
    title: 'Get business profile',
    description:
      'Read the stored business profile: jurisdiction, legal form, books, VAT status, e-EFKA amount, ' +
      'imputed income floor and accountant details. Call this first — every other tool depends on it.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  handler(() => {
    const profile = readProfile();
    if (!profile) {
      return {
        configured: false,
        message:
          'No profile yet. Call profile_set with at least jurisdiction, legal_form, books and vat_status.',
        available_jurisdictions: ['gr'],
      };
    }
    const { pack } = loadPack(profile.jurisdiction);
    return {
      configured: true,
      profile,
      jurisdiction: { id: pack.id, name: pack.name, currency: pack.currency },
      missing_recommended: [
        !profile.efka_monthly_amount && 'efka_monthly_amount (from your e-EFKA notice)',
        !profile.imputed_income_floor && 'imputed_income_floor (ask your accountant)',
        !profile.accountant?.email && 'accountant.email',
      ].filter(Boolean),
    };
  }),
);

server.registerTool(
  'profile_set',
  {
    title: 'Create or update the business profile',
    description:
      'Set or partially update the business profile. Only the fields you pass are changed. ' +
      'efka_monthly_amount and imputed_income_floor should be copied from real documents, not guessed.',
    inputSchema: {
      jurisdiction: z.string().optional().describe('Jurisdiction pack id, e.g. "gr"'),
      business_name: z.string().optional(),
      vat_number: z.string().optional().describe('ΑΦΜ / VAT number'),
      legal_form: z.string().optional().describe('e.g. "sole_trader", "ike"'),
      books: z.enum(['simple', 'double']).optional().describe('απλογραφικά = simple, διπλογραφικά = double'),
      vat_status: z.enum(['registered', 'exempt_small', 'not_registered']).optional(),
      activity_started_on: z.string().optional().describe('YYYY-MM-DD, date of έναρξη εργασιών'),
      tracking_since: z
        .string()
        .optional()
        .describe(
          'YYYY-MM-DD from which this tool is accountable. Obligations due before it are reported ' +
            'separately rather than as missed. Defaults to today on first setup.',
        ),
      has_intra_eu_b2b: z.boolean().optional().describe('Do you invoice business clients in other EU countries?'),
      registered_for_oss: z.boolean().optional(),
      efka_monthly_amount: z.number().optional().describe('Monthly e-EFKA contribution, from your ειδοποιητήριο'),
      efka_amount_verified_on: z.string().optional().describe('YYYY-MM-DD when you last checked that amount'),
      imputed_income_floor: z.number().optional().describe('Minimum imputed net income (τεκμαρτό), from your accountant'),
      imputed_floor_verified_on: z.string().optional(),
      accountant_name: z.string().optional(),
      accountant_email: z.string().optional(),
      accountant_phone: z.string().optional(),
      accountant_responsible_for: z
        .array(z.string())
        .optional()
        .describe('Obligation ids your accountant has agreed to handle'),
    },
  },
  handler((args: Record<string, unknown>) => {
    const existing = readProfile();
    const next: Profile = {
      jurisdiction: (args.jurisdiction as string) ?? existing?.jurisdiction ?? 'gr',
      business_name: (args.business_name as string) ?? existing?.business_name,
      vat_number: (args.vat_number as string) ?? existing?.vat_number,
      legal_form: (args.legal_form as string) ?? existing?.legal_form ?? 'sole_trader',
      books: (args.books as Profile['books']) ?? existing?.books ?? 'simple',
      vat_status: (args.vat_status as Profile['vat_status']) ?? existing?.vat_status ?? 'registered',
      activity_started_on: (args.activity_started_on as string) ?? existing?.activity_started_on,
      // On first setup, start the clock today rather than retroactively judging
      // periods this tool was never watching.
      tracking_since:
        (args.tracking_since as string) ?? existing?.tracking_since ?? todayInZone(),
      has_intra_eu_b2b: (args.has_intra_eu_b2b as boolean) ?? existing?.has_intra_eu_b2b,
      registered_for_oss: (args.registered_for_oss as boolean) ?? existing?.registered_for_oss,
      efka_monthly_amount: (args.efka_monthly_amount as number) ?? existing?.efka_monthly_amount,
      efka_amount_verified_on: (args.efka_amount_verified_on as string) ?? existing?.efka_amount_verified_on,
      imputed_income_floor: (args.imputed_income_floor as number) ?? existing?.imputed_income_floor,
      imputed_floor_verified_on: (args.imputed_floor_verified_on as string) ?? existing?.imputed_floor_verified_on,
      accountant: {
        name: (args.accountant_name as string) ?? existing?.accountant?.name,
        email: (args.accountant_email as string) ?? existing?.accountant?.email,
        phone: (args.accountant_phone as string) ?? existing?.accountant?.phone,
        responsible_for:
          (args.accountant_responsible_for as string[]) ?? existing?.accountant?.responsible_for,
      },
    };

    // Fail loudly now rather than on the first deadline query.
    loadPack(next.jurisdiction);
    writeProfile(next);
    return { saved: true, profile: next };
  }),
);

// ---------------------------------------------------------------------------
// Obligations and compliance
// ---------------------------------------------------------------------------

server.registerTool(
  'obligations_upcoming',
  {
    title: 'Upcoming and overdue obligations',
    description:
      'The deadline radar. Returns every statutory obligation whose due date falls in the window, ' +
      'classified as missed / at_risk / upcoming / scheduled / done, with the action to take. ' +
      'Defaults to 60 days ahead and 90 days back so nothing recently missed slips out of view.',
    inputSchema: {
      days_ahead: z.number().int().min(1).max(730).optional(),
      days_back: z.number().int().min(0).max(730).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  handler((args: { days_ahead?: number; days_back?: number }) => {
    const today = todayInZone();
    const from = addDays(today, -(args.days_back ?? 90));
    const to = addDays(today, args.days_ahead ?? 60);
    const { instances, profile } = instancesBetween(from, to);
    return buildComplianceReport({
      instances,
      filings: filings.all(),
      today,
      from,
      to,
      trackingSince: profile.tracking_since,
    });
  }),
);

server.registerTool(
  'obligations_calendar',
  {
    title: 'Obligation calendar for a date range',
    description:
      'All obligation instances due between two dates, with computed due dates that account for ' +
      'weekends and public holidays. Use this to answer "what does my year look like".',
    inputSchema: {
      from: z.string().describe('YYYY-MM-DD'),
      to: z.string().describe('YYYY-MM-DD'),
    },
    annotations: { readOnlyHint: true },
  },
  handler((args: { from: string; to: string }) => {
    const { instances, today, pack } = instancesBetween(args.from, args.to);
    return {
      as_of: today,
      jurisdiction: pack.id,
      count: instances.length,
      instances,
      note:
        'Dates marked often_extended are frequently pushed back by ministerial decision. Never plan ' +
        'around an extension that has not been announced.',
    };
  }),
);

server.registerTool(
  'obligation_record',
  {
    title: 'Record what happened with an obligation',
    description:
      'Log that an obligation was submitted, paid, confirmed, missed, or does not apply. ' +
      'This is what turns the calendar into an audit trail — and what makes the accountant scorecard ' +
      'meaningful. Always record the submission reference when you have one.',
    inputSchema: {
      instance_id: z.string().describe('From obligations_upcoming, e.g. "gr.vat.return.quarterly:2026-Q2"'),
      status: z.enum(['pending', 'submitted', 'paid', 'confirmed', 'missed', 'not_applicable']),
      completed_on: z.string().optional().describe('YYYY-MM-DD the work was actually done'),
      amount: z.number().optional(),
      reference: z.string().optional().describe('Submission number, ΜΑΡΚ, payment code'),
      evidence: z.string().optional().describe('Where the proof lives (file path, email, Drive link)'),
      done_by: z.enum(['accountant', 'you', 'either']).optional(),
      notes: z.string().optional(),
    },
  },
  handler((args: Record<string, unknown>) => {
    const instanceId = args.instance_id as string;
    const [obligationId, periodKey] = instanceId.split(':');
    if (!obligationId || !periodKey) {
      throw new Error(`instance_id must look like "<obligation_id>:<period>", got "${instanceId}".`);
    }

    const { today } = context();
    // Resolve the real due date so the record is self-contained.
    const wide = instancesBetween(addDays(today, -1200), addDays(today, 800));
    const match = wide.instances.find((i) => i.instance_id === instanceId);

    const record: FilingRecord = {
      instance_id: instanceId,
      obligation_id: obligationId,
      period_key: periodKey,
      due_date: match?.due_date ?? today,
      status: args.status as FilingRecord['status'],
      completed_on: (args.completed_on as string) ?? (args.status === 'pending' ? undefined : today),
      amount: args.amount as number | undefined,
      reference: args.reference as string | undefined,
      evidence: args.evidence as string | undefined,
      done_by: args.done_by as FilingRecord['done_by'],
      notes: args.notes as string | undefined,
      updated_at: new Date().toISOString(),
    };

    const saved = filings.upsert(record);
    const late = saved.completed_on && saved.completed_on > saved.due_date;
    return {
      saved,
      matched_known_obligation: Boolean(match),
      late: Boolean(late),
      note: match
        ? late
          ? `Recorded as completed on ${saved.completed_on}, after the ${saved.due_date} deadline. This will show as a late filing in the scorecard.`
          : undefined
        : `No obligation instance "${instanceId}" was found in the calendar. The record was saved anyway, but check the id — a typo here means the real obligation still shows as unfiled.`,
    };
  }),
);

server.registerTool(
  'compliance_report',
  {
    title: 'Full compliance report',
    description: 'Compliance status across an explicit date range, rather than the rolling default window.',
    inputSchema: { from: z.string(), to: z.string() },
    annotations: { readOnlyHint: true },
  },
  handler((args: { from: string; to: string }) => {
    const { instances, today, profile } = instancesBetween(args.from, args.to);
    return buildComplianceReport({
      instances,
      filings: filings.all(),
      today,
      from: args.from,
      to: args.to,
      trackingSince: profile.tracking_since,
    });
  }),
);

server.registerTool(
  'accountant_scorecard',
  {
    title: 'Accountant accountability scorecard',
    description:
      'How your accountant is actually performing: obligations they own, filed on time vs late vs ' +
      'overdue-and-unconfirmed, plus your requests that went unanswered past their deadline. ' +
      'Built from recorded facts so it can be raised in a conversation without it being a matter of opinion.',
    inputSchema: {
      from: z.string().optional().describe('YYYY-MM-DD, defaults to 12 months ago'),
      to: z.string().optional().describe('YYYY-MM-DD, defaults to today'),
    },
    annotations: { readOnlyHint: true },
  },
  handler((args: { from?: string; to?: string }) => {
    const today = todayInZone();
    const from = args.from ?? addDays(today, -365);
    const to = args.to ?? today;
    const { instances, profile } = instancesBetween(from, to);
    return buildAccountantScorecard({
      instances,
      filings: filings.all(),
      handoffs: handoffStore.all(),
      profile,
      today,
      from,
      to,
    });
  }),
);

// ---------------------------------------------------------------------------
// Accountant handoffs
// ---------------------------------------------------------------------------

server.registerTool(
  'handoff_log',
  {
    title: 'Log a request to or reply from the accountant',
    description:
      'Record something you asked your accountant, or something they told you. Set response_needed_by ' +
      'on requests — an unanswered request past its date is what the scorecard counts. Log the reply ' +
      'with handoff_respond when it arrives.',
    inputSchema: {
      direction: z.enum(['sent', 'received']),
      subject: z.string(),
      date: z.string().optional().describe('YYYY-MM-DD, defaults to today'),
      body: z.string().optional(),
      channel: z.string().optional().describe('email, phone, whatsapp, in person'),
      relates_to: z.array(z.string()).optional().describe('Obligation instance ids this concerns'),
      response_needed_by: z.string().optional().describe('YYYY-MM-DD'),
    },
  },
  handler((args: Record<string, unknown>) => {
    const today = todayInZone();
    return handoffStore.add({
      id: newId('ho'),
      date: (args.date as string) ?? today,
      direction: args.direction as 'sent' | 'received',
      channel: args.channel as string | undefined,
      subject: args.subject as string,
      body: args.body as string | undefined,
      relates_to: args.relates_to as string[] | undefined,
      response_needed_by: args.response_needed_by as string | undefined,
      created_at: new Date().toISOString(),
    });
  }),
);

server.registerTool(
  'handoff_respond',
  {
    title: 'Mark a request as answered',
    description: 'Close the loop on a logged request so it stops counting as unanswered.',
    inputSchema: {
      id: z.string(),
      responded_on: z.string().optional().describe('YYYY-MM-DD, defaults to today'),
      notes: z.string().optional(),
    },
  },
  handler((args: { id: string; responded_on?: string; notes?: string }) => {
    const existing = handoffStore.get(args.id);
    if (!existing) throw new Error(`No handoff with id "${args.id}".`);
    return handoffStore.update(args.id, {
      responded_on: args.responded_on ?? todayInZone(),
      body: args.notes ? `${existing.body ?? ''}\n\n[reply] ${args.notes}`.trim() : existing.body,
    });
  }),
);

server.registerTool(
  'handoff_list',
  {
    title: 'List accountant correspondence',
    description: 'The logged history with your accountant, newest first. Filter to only unanswered requests.',
    inputSchema: { unanswered_only: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  },
  handler((args: { unanswered_only?: boolean }) => {
    const today = todayInZone();
    let all = [...handoffStore.all()].sort((a, b) => (a.date < b.date ? 1 : -1));
    if (args.unanswered_only) all = all.filter((h) => h.direction === 'sent' && !h.responded_on);
    return {
      count: all.length,
      handoffs: all.map((h) => ({ ...h, days_waiting: h.responded_on ? undefined : daysBetween(h.date, today) })),
    };
  }),
);

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

server.registerTool(
  'invoice_create',
  {
    title: 'Record an issued invoice',
    description:
      'Record a sales invoice. VAT and withholding tax are computed from the jurisdiction pack unless ' +
      'you override them. For Greek business clients, withholding tax is applied by default — the client ' +
      'keeps that amount and pays it to the tax authority against your income tax, so your bank receives ' +
      'less than the invoice total. For EU business clients with a VAT number, pass reverse_charge.',
    inputSchema: {
      client: z.string(),
      net_amount: z.number().positive().describe('Amount before VAT'),
      issue_date: z.string().optional().describe('YYYY-MM-DD, defaults to today'),
      number: z.string().optional(),
      client_vat_number: z.string().optional(),
      client_country: z.string().optional().describe('ISO code, e.g. GR, DE, US'),
      due_date: z.string().optional(),
      description: z.string().optional(),
      vat_rate: z.number().optional().describe('Overrides the pack standard rate'),
      reverse_charge: z.boolean().optional().describe('Intra-EU B2B: no VAT charged, customer self-accounts'),
      client_withholds_tax: z.boolean().optional().describe('Defaults to true for Greek business clients'),
      mydata_mark: z.string().optional().describe('ΜΑΡΚ from myDATA'),
      notes: z.string().optional(),
    },
  },
  handler((args: Record<string, unknown>) => {
    const { pack, today } = context();
    const issueDate = (args.issue_date as string) ?? today;

    const vatParam = resolveParameter<number>(pack, 'vat_standard_rate', issueDate, today);
    const whParam = resolveParameter<number>(pack, 'withholding_tax_professional_services', issueDate, today);

    const country = ((args.client_country as string) ?? 'GR').toUpperCase();
    const inferredWithholding =
      country === 'GR' && Boolean(args.client_vat_number) && !args.reverse_charge;
    const withholds = (args.client_withholds_tax as boolean | undefined) ?? inferredWithholding;

    const invoice = buildInvoice({
      client: args.client as string,
      net_amount: args.net_amount as number,
      issue_date: issueDate,
      number: args.number as string | undefined,
      client_vat_number: args.client_vat_number as string | undefined,
      client_country: country,
      due_date: args.due_date as string | undefined,
      description: args.description as string | undefined,
      vat_rate: (args.vat_rate as number) ?? vatParam.value ?? 0,
      reverse_charge: args.reverse_charge as boolean | undefined,
      withholding_rate: withholds ? (whParam.value ?? 0) : 0,
      mydata_mark: args.mydata_mark as string | undefined,
      notes: args.notes as string | undefined,
    });

    invoiceStore.add(invoice);

    const warnings = [...vatParam.warnings, ...(withholds ? whParam.warnings : [])];
    if (args.client_withholds_tax === undefined) {
      warnings.push(
        withholds
          ? 'Withholding tax was applied by inference (Greek client with a VAT number). Pass client_withholds_tax explicitly if that is wrong.'
          : 'No withholding tax was applied. If this is a Greek business client, pass client_withholds_tax: true.',
      );
    }
    if (!invoice.mydata_mark) {
      warnings.push('No myDATA ΜΑΡΚ recorded. An invoice without a ΜΑΡΚ is not a valid document — add it once issued.');
    }

    return {
      invoice,
      explanation: {
        net: invoice.net_amount,
        vat: invoice.vat_amount,
        withheld_by_client: invoice.withholding_amount,
        expected_in_your_bank: invoice.payable_amount,
        note:
          invoice.withholding_amount > 0
            ? `The client keeps ${invoice.withholding_amount} as withholding tax. That is not lost — it counts against your income tax bill, and this ledger tracks it so you claim it.`
            : undefined,
      },
      warnings,
    };
  }),
);

server.registerTool(
  'invoice_mark_paid',
  {
    title: 'Mark an invoice paid',
    inputSchema: {
      id: z.string(),
      paid_date: z.string().optional().describe('YYYY-MM-DD, defaults to today'),
      paid_amount: z.number().optional().describe('Defaults to the full payable amount'),
    },
  },
  handler((args: { id: string; paid_date?: string; paid_amount?: number }) => {
    const invoice = invoiceStore.get(args.id);
    if (!invoice) throw new Error(`No invoice with id "${args.id}".`);
    const paidAmount = args.paid_amount ?? invoice.payable_amount;
    const short = paidAmount < invoice.payable_amount - 0.01;
    return {
      invoice: invoiceStore.update(args.id, {
        status: short ? 'partially_paid' : 'paid',
        paid_date: args.paid_date ?? todayInZone(),
        paid_amount: paidAmount,
      }),
      note: short
        ? `Paid ${paidAmount} against ${invoice.payable_amount} expected. If the shortfall equals the withholding amount, the client may have withheld twice — check before writing it off.`
        : undefined,
    };
  }),
);

server.registerTool(
  'invoice_list',
  {
    title: 'List invoices',
    description: 'Invoices, optionally filtered by period (2026, 2026-Q2, 2026-06), status or client.',
    inputSchema: {
      period: z.string().optional(),
      status: z.enum(['draft', 'issued', 'paid', 'partially_paid', 'cancelled']).optional(),
      client: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  handler(async (args: { period?: string; status?: string; client?: string }) => {
    const { parsePeriod } = await import('./domain/estimates.js');
    let all = invoiceStore.all();
    if (args.period) {
      const period = parsePeriod(args.period);
      all = all.filter((i) => i.issue_date >= period.start && i.issue_date <= period.end);
    }
    if (args.status) all = all.filter((i) => i.status === args.status);
    if (args.client) {
      const needle = args.client.toLowerCase();
      all = all.filter((i) => i.client.toLowerCase().includes(needle));
    }
    all.sort((a, b) => (a.issue_date < b.issue_date ? 1 : -1));
    return {
      count: all.length,
      total_net: all.reduce((total, i) => total + i.net_amount, 0),
      invoices: all,
    };
  }),
);

server.registerTool(
  'receivables_aging',
  {
    title: 'Unpaid invoices by age',
    description:
      'Unpaid invoices bucketed by how overdue they are. Worth running before every VAT deadline: ' +
      'in Greece the VAT on an invoice is generally due for the period it was issued, whether or not ' +
      'the client has paid you.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  handler(() => {
    const today = todayInZone();
    const buckets = agingReport(invoiceStore.all(), today, daysBetween);
    return {
      as_of: today,
      total_outstanding: buckets.reduce((total, b) => total + b.total, 0),
      buckets,
    };
  }),
);

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

server.registerTool(
  'expense_record',
  {
    title: 'Record a business expense',
    description:
      'Record a deductible expense. Always set document_location — input VAT without a document is not ' +
      'deductible under audit. Use vat_deductible_ratio below 1 for mixed personal/business items.',
    inputSchema: {
      supplier: z.string(),
      net_amount: z.number().positive().describe('Amount before VAT'),
      date: z.string().optional().describe('YYYY-MM-DD, defaults to today'),
      vat_rate: z.number().optional().describe('Defaults to the pack standard rate'),
      vat_deductible_ratio: z.number().min(0).max(1).optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      document_ref: z.string().optional().describe('Invoice number'),
      document_location: z.string().optional().describe('Where the file lives'),
    },
  },
  handler((args: Record<string, unknown>) => {
    const { pack, today } = context();
    const date = (args.date as string) ?? today;
    const vatParam = resolveParameter<number>(pack, 'vat_standard_rate', date, today);

    const expense = buildExpense({
      supplier: args.supplier as string,
      date,
      net_amount: args.net_amount as number,
      vat_rate: (args.vat_rate as number) ?? vatParam.value ?? 0,
      vat_deductible_ratio: args.vat_deductible_ratio as number | undefined,
      description: args.description as string | undefined,
      category: args.category as string | undefined,
      document_ref: args.document_ref as string | undefined,
      document_location: args.document_location as string | undefined,
    });

    expenseStore.add(expense);
    const warnings = [...vatParam.warnings];
    if (!expense.document_ref && !expense.document_location) {
      warnings.push('No document reference or location recorded. Add one — an undocumented expense is an undeductible expense.');
    }
    return { expense, warnings };
  }),
);

server.registerTool(
  'expense_list',
  {
    title: 'List expenses',
    inputSchema: { period: z.string().optional(), category: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  handler(async (args: { period?: string; category?: string }) => {
    const { parsePeriod } = await import('./domain/estimates.js');
    let all = expenseStore.all();
    if (args.period) {
      const period = parsePeriod(args.period);
      all = all.filter((e) => e.date >= period.start && e.date <= period.end);
    }
    if (args.category) all = all.filter((e) => e.category === args.category);
    all.sort((a, b) => (a.date < b.date ? 1 : -1));
    return { count: all.length, total_net: all.reduce((t, e) => t + e.net_amount, 0), expenses: all };
  }),
);

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

server.registerTool(
  'vat_estimate',
  {
    title: 'Estimate the VAT position for a period',
    description:
      'Output VAT less deductible input VAT for a period (2026-Q2, 2026-06). Run this before the filing ' +
      'deadline so you know the number your accountant should be reporting, and so you can spot missing ' +
      'documents while there is still time to find them.',
    inputSchema: { period: z.string().describe('e.g. 2026-Q2') },
    annotations: { readOnlyHint: true },
  },
  handler((args: { period: string }) => {
    const { profile } = context();
    return estimateVat({
      periodKey: args.period,
      invoices: invoiceStore.all(),
      expenses: expenseStore.all(),
      profile,
    });
  }),
);

server.registerTool(
  'income_tax_estimate',
  {
    title: 'Estimate income tax and what to set aside',
    description:
      'Estimates income tax, next-year prepayment and the balance due for a tax year, then suggests what ' +
      'fraction of every incoming euro to hold back. Read the warnings: this depends on parameters that ' +
      'change annually and on figures only your accountant can give you.',
    inputSchema: {
      year: z.number().int().min(2015).max(2100),
      prior_year_prepayment_credit: z
        .number()
        .optional()
        .describe('Prepayment already made last year, from your εκκαθαριστικό'),
    },
    annotations: { readOnlyHint: true },
  },
  handler((args: { year: number; prior_year_prepayment_credit?: number }) => {
    const { profile, pack, today } = context();
    return estimateIncomeTax({
      year: args.year,
      invoices: invoiceStore.all(),
      expenses: expenseStore.all(),
      profile,
      pack,
      today,
      priorYearPrepaymentCredit: args.prior_year_prepayment_credit,
    });
  }),
);

// ---------------------------------------------------------------------------
// Rules: parameters, pending changes, source watching
// ---------------------------------------------------------------------------

server.registerTool(
  'rules_parameter',
  {
    title: 'Read a tax parameter with its provenance',
    description:
      'Returns a parameter value together with its source, when it was last verified, and whether it is ' +
      'stale. Never quote a rate to the user without this. Omit `name` to list every parameter.',
    inputSchema: {
      name: z.string().optional(),
      as_of: z.string().optional().describe('YYYY-MM-DD; which date the value should be in force on'),
    },
    annotations: { readOnlyHint: true },
  },
  handler((args: { name?: string; as_of?: string }) => {
    const { pack, today } = context();
    const asOf = args.as_of ?? today;
    if (args.name) return resolveParameter(pack, args.name, asOf, today);
    return {
      as_of: asOf,
      parameters: Object.keys(pack.parameters ?? {}).map((name) =>
        resolveParameter(pack, name, asOf, today),
      ),
    };
  }),
);

server.registerTool(
  'rules_pending_changes',
  {
    title: 'Announced rule changes that will affect this business',
    description:
      'Changes that have been announced but are not yet reflected in the pack\'s parameters, filtered to ' +
      'the ones that affect this business. This is the "nobody told me it changed" tool — run it monthly.',
    inputSchema: { include_past: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  },
  handler((args: { include_past?: boolean }) => {
    const { pack, profile, today } = context();
    const all = pack.pending_changes ?? [];
    const relevant = all
      .filter((change) => change.affects.includes(profile.legal_form))
      .filter((change) => args.include_past || change.expected_date >= addDays(today, -365))
      .map((change) => ({ ...change, days_until: daysBetween(today, change.expected_date) }))
      .sort((a, b) => a.days_until - b.days_until);

    return {
      as_of: today,
      count: relevant.length,
      changes: relevant,
      note:
        'These entries are maintained by hand in the jurisdiction pack and each is marked with a ' +
        'confidence level. Verify against the linked official source before acting — and if you confirm ' +
        'or correct one, please open a pull request so the next person gets it right.',
    };
  }),
);

server.registerTool(
  'rules_check_sources',
  {
    title: 'Check official sources for changes',
    description:
      'Fetches the official pages listed in the jurisdiction pack and reports which have changed since ' +
      'the last check. It flags *that* something changed, not what — read the changed pages to judge. ' +
      'Sensible to run weekly.',
    inputSchema: { source_ids: z.array(z.string()).optional().describe('Defaults to all sources in the pack') },
  },
  handler(async (args: { source_ids?: string[] }) => {
    const { pack, today } = context();
    let sources = pack.watch_sources ?? [];
    if (args.source_ids?.length) sources = sources.filter((s) => args.source_ids!.includes(s.id));
    if (sources.length === 0) return { checked: 0, results: [], note: 'No watch sources matched.' };

    const results = await checkAll(sources);
    const changed = results.filter((r) => r.status === 'changed');
    const errored = results.filter((r) => r.status === 'error');

    return {
      as_of: today,
      checked: results.length,
      changed: changed.length,
      results,
      next_step:
        changed.length > 0
          ? 'Read each changed page, decide whether it affects this business, and record your judgement with rules_change_assess.'
          : 'Nothing changed. No action needed.',
      errors_note:
        errored.length > 0
          ? `${errored.length} source(s) could not be fetched. Government sites rate-limit and go down; retry later before assuming anything.`
          : undefined,
    };
  }),
);

server.registerTool(
  'rules_change_assess',
  {
    title: 'Record what a detected change means',
    description:
      'Attach your judgement to a detected source change and mark it acknowledged, so the same change ' +
      'is not re-surfaced every week.',
    inputSchema: {
      id: z.string(),
      assessment: z.string().describe('What actually changed and whether it affects this business'),
      relevant: z.boolean(),
    },
  },
  handler((args: { id: string; assessment: string; relevant: boolean }) => {
    const existing = changes.get(args.id);
    if (!existing) throw new Error(`No detected change with id "${args.id}".`);
    return changes.update(args.id, {
      assessment: args.assessment,
      relevant: args.relevant,
      acknowledged: true,
    });
  }),
);

server.registerTool(
  'rules_changes_list',
  {
    title: 'List detected source changes',
    inputSchema: { unacknowledged_only: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  },
  handler((args: { unacknowledged_only?: boolean }) => {
    let all = [...changes.all()].sort((a, b) => (a.detected_at < b.detected_at ? 1 : -1));
    if (args.unacknowledged_only) all = all.filter((c) => !c.acknowledged);
    return { count: all.length, changes: all };
  }),
);

server.registerTool(
  'pack_health',
  {
    title: 'Jurisdiction pack health check',
    description:
      'Which facts in the rules pack are stale, low-confidence or unverified. Run this at the start of ' +
      'any session that will produce numbers, and tell the user plainly if the pack needs updating.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  handler(() => {
    const { pack, today } = context();
    return packHealth(pack, today);
  }),
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP transport.
  process.stderr.write('logistis MCP server ready\n');
}

main().catch((error) => {
  process.stderr.write(`logistis failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});

export type { Bracket };
