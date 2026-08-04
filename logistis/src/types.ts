/**
 * Shared types.
 *
 * Dates are ISO `YYYY-MM-DD` strings throughout. Deliberately not `Date`:
 * everything here is a calendar date in Europe/Athens, and JavaScript `Date`
 * drags a timezone along that turns "due on the 31st" into "due on the 30th"
 * for anyone running the server from a different offset. Strings do not have
 * that failure mode.
 */

export type IsoDate = string;

/** How confident the pack maintainers are in a given fact. */
export type Confidence = 'high' | 'medium' | 'low';

// ---------------------------------------------------------------------------
// Jurisdiction pack
// ---------------------------------------------------------------------------

export interface Provenance {
  source?: string;
  secondary_sources?: string[];
  sources?: string[];
  verified_on?: IsoDate;
  review_by?: IsoDate;
  confidence?: Confidence;
  needs_verification?: boolean;
  warning?: string;
  notes?: string;
}

export type DueRule =
  | 'last_business_day_of_month'
  | 'day_of_month'
  | 'fixed_date'
  | 'fixed_day_in_year'
  /** A run of monthly payments from one assessment, e.g. tax in 8 installments. */
  | 'installment_series';

export interface DueSpec {
  rule: DueRule;
  /** For monthly/quarterly rules: months after the end of the period. */
  months_after_period_end?: number;
  /** For `day_of_month`: the target day (rolled forward off non-working days). */
  day?: number;
  /** For `fixed_day_in_year`. */
  month?: number;
  years_after_period_end?: number;
  /** For `fixed_date`. */
  date?: IsoDate;
  /** For `installment_series`: how many monthly installments. */
  count?: number;
}

export interface ScheduleSpec {
  frequency: 'monthly' | 'quarterly' | 'annual' | 'once';
  due: DueSpec;
}

export type ObligationOwner = 'accountant' | 'you' | 'either';

export interface ObligationDef extends Provenance {
  id: string;
  name: string;
  name_en?: string;
  category: string;
  authority?: string;
  owner: ObligationOwner;
  applies_when?: Record<string, unknown>;
  schedule: ScheduleSpec;
  reminders?: number[];
  penalty_if_late?: string;
  what_you_must_supply?: string;
  action_required?: string;
  often_extended?: boolean;
}

export interface Bracket {
  up_to: number | null;
  rate: number;
}

export interface DatedValue<T = unknown> {
  value?: T;
  effective_from: IsoDate;
  note?: string;
}

export interface ParameterDef extends Provenance {
  label: string;
  label_en?: string;
  unit: string;
  values: DatedValue[];
  applies_to?: string;
}

export interface PendingChange extends Provenance {
  id: string;
  title: string;
  title_el?: string;
  expected_date: IsoDate;
  affects: string[];
  impact: 'high' | 'medium' | 'low';
  summary: string;
  what_to_do: string;
}

/**
 * `official` sources are authoritative but slow. `community` sources (the tax
 * press, professional portals) are fast and practical but secondary — they are
 * an early warning, never a citation. See the SOURCE POLICY block in the pack.
 */
export type SourceTier = 'official' | 'community';

export interface WatchSource {
  id: string;
  label: string;
  url: string;
  tier?: SourceTier;
  relevance: 'high' | 'medium' | 'low';
  note?: string;
}

export interface JurisdictionPack {
  id: string;
  name: string;
  name_local?: string;
  currency: string;
  locale?: string;
  timezone?: string;
  authorities?: { id: string; name: string; name_en?: string; url: string }[];
  meta: {
    pack_version: string;
    last_reviewed: IsoDate;
    review_cadence?: string;
    disclaimer: string;
  };
  profile_schema?: Record<string, unknown>;
  obligations: ObligationDef[];
  parameters: Record<string, ParameterDef>;
  pending_changes?: PendingChange[];
  watch_sources?: WatchSource[];
}

export interface HolidayPack {
  fixed: { month: number; day: number; name: string; name_en?: string }[];
  movable: { offset: number; name: string; name_en?: string }[];
}

// ---------------------------------------------------------------------------
// Business profile
// ---------------------------------------------------------------------------

export interface Profile {
  jurisdiction: string;
  business_name?: string;
  vat_number?: string;
  legal_form: string;
  books: 'simple' | 'double';
  vat_status: 'registered' | 'exempt_small' | 'not_registered';
  activity_started_on?: IsoDate;

  /**
   * The date from which this tool is responsible for tracking.
   *
   * Obligations that fell due before it are reported separately rather than as
   * missed. Without this, day one of using Logistis shows a wall of red for
   * periods it was never watching — and an alarm that is always on is an alarm
   * nobody reads. Defaults to the day the profile is first created.
   */
  tracking_since?: IsoDate;

  has_intra_eu_b2b?: boolean;
  registered_for_oss?: boolean;

  /**
   * Copied from your actual e-EFKA notice. The pack refuses to guess this —
   * see the `efka_contribution_categories` parameter for why.
   */
  efka_monthly_amount?: number;
  efka_amount_verified_on?: IsoDate;

  /** Your imputed minimum net income floor, as told to you by your accountant. */
  imputed_income_floor?: number;
  imputed_floor_verified_on?: IsoDate;

  accountant?: {
    name?: string;
    email?: string;
    phone?: string;
    /** Obligations you have agreed they handle. Drives the accountability report. */
    responsible_for?: string[];
  };
}

// ---------------------------------------------------------------------------
// Ledger records
// ---------------------------------------------------------------------------

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'partially_paid' | 'cancelled';

export interface Invoice {
  id: string;
  number?: string;
  client: string;
  client_vat_number?: string;
  client_country?: string;
  issue_date: IsoDate;
  due_date?: IsoDate;
  description?: string;
  /** Amount before VAT, in the pack currency. */
  net_amount: number;
  vat_rate: number;
  vat_amount: number;
  /** Tax the client withholds and remits on your behalf. */
  withholding_amount: number;
  /** What should actually land in your bank account. */
  payable_amount: number;
  status: InvoiceStatus;
  paid_date?: IsoDate;
  paid_amount?: number;
  /** True for reverse-charged intra-EU B2B supplies. */
  reverse_charge?: boolean;
  mydata_mark?: string;
  notes?: string;
  created_at: string;
}

export interface Expense {
  id: string;
  supplier: string;
  date: IsoDate;
  description?: string;
  net_amount: number;
  vat_rate: number;
  vat_amount: number;
  /** Portion of VAT you may reclaim (0–1). Mixed-use items are rarely 1. */
  vat_deductible_ratio: number;
  category?: string;
  document_ref?: string;
  /** Where the source document lives, so an audit is not an archaeology dig. */
  document_location?: string;
  created_at: string;
}

export type FilingStatus = 'pending' | 'submitted' | 'paid' | 'confirmed' | 'missed' | 'not_applicable';

export interface FilingRecord {
  /** `${obligationId}:${periodKey}` */
  instance_id: string;
  obligation_id: string;
  period_key: string;
  due_date: IsoDate;
  status: FilingStatus;
  completed_on?: IsoDate;
  amount?: number;
  reference?: string;
  evidence?: string;
  done_by?: ObligationOwner;
  notes?: string;
  updated_at: string;
}

/**
 * A logged interaction with the accountant.
 *
 * This is the record that turns "I feel like they never respond" into
 * "here are the four requests that went unanswered before the deadline."
 */
export interface Handoff {
  id: string;
  date: IsoDate;
  direction: 'sent' | 'received';
  channel?: string;
  subject: string;
  body?: string;
  /** Obligation instance ids this relates to. */
  relates_to?: string[];
  /** For `sent`: when you needed an answer by. */
  response_needed_by?: IsoDate;
  responded_on?: IsoDate;
  created_at: string;
}

export interface SourceSnapshot {
  source_id: string;
  url: string;
  hash: string;
  checked_at: string;
  /** Short excerpt, so a diff can be described rather than just flagged. */
  excerpt?: string;
}

export interface DetectedChange {
  id: string;
  source_id: string;
  url: string;
  detected_at: string;
  previous_hash: string;
  new_hash: string;
  /** Set once a human or the agent has read the page and judged it. */
  assessment?: string;
  relevant?: boolean;
  acknowledged?: boolean;
}
