/**
 * Turns obligation *rules* into concrete dated *instances*.
 *
 * An obligation like "quarterly VAT return, due the last working day of the
 * month after the quarter ends" becomes, for 2026: four instances with real
 * dates that account for Greek weekends and public holidays.
 */

import type { HolidayPack, IsoDate, ObligationDef, Profile } from '../types.js';
import {
  addMonths,
  daysBetween,
  lastBusinessDayOfMonth,
  lastDayOfMonth,
  parseIso,
  rollForward,
  toIso,
} from './businessDays.js';

export interface ObligationInstance {
  instance_id: string;
  obligation_id: string;
  name: string;
  name_en?: string;
  category: string;
  owner: string;
  period_key: string;
  period_start?: IsoDate;
  period_end?: IsoDate;
  due_date: IsoDate;
  /** Negative when overdue. */
  days_until_due: number;
  reminders: number[];
  often_extended?: boolean;
  penalty_if_late?: string;
  what_you_must_supply?: string;
  action_required?: string;
  needs_verification?: boolean;
  confidence?: string;
  source?: string;
}

interface Period {
  key: string;
  start?: IsoDate;
  end?: IsoDate;
  /** Year and month the period ends in, used as the offset base. */
  endY: number;
  endM: number;
}

/**
 * Does this obligation apply to this profile?
 *
 * `applies_when` is a flat map of profile field -> allowed value(s). A field
 * absent from the profile does not match a positive requirement, so a profile
 * that has not declared `has_intra_eu_b2b` will not be nagged about VIES.
 */
export function appliesTo(def: ObligationDef, profile: Profile): boolean {
  const conditions = def.applies_when;
  if (!conditions) return true;

  for (const [field, expected] of Object.entries(conditions)) {
    const actual = (profile as unknown as Record<string, unknown>)[field];
    if (Array.isArray(expected)) {
      if (actual === undefined || !expected.includes(actual as never)) return false;
    } else if (typeof expected === 'boolean') {
      if (Boolean(actual) !== expected) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function periodsFor(def: ObligationDef, fromYear: number, toYear: number): Period[] {
  const out: Period[] = [];

  switch (def.schedule.frequency) {
    case 'monthly':
      for (let y = fromYear; y <= toYear; y++) {
        for (let m = 1; m <= 12; m++) {
          out.push({
            key: `${y}-${String(m).padStart(2, '0')}`,
            start: toIso({ y, m, d: 1 }),
            end: toIso({ y, m, d: lastDayOfMonth(y, m) }),
            endY: y,
            endM: m,
          });
        }
      }
      break;

    case 'quarterly':
      for (let y = fromYear; y <= toYear; y++) {
        for (let q = 1; q <= 4; q++) {
          const startM = (q - 1) * 3 + 1;
          const endM = startM + 2;
          out.push({
            key: `${y}-Q${q}`,
            start: toIso({ y, m: startM, d: 1 }),
            end: toIso({ y, m: endM, d: lastDayOfMonth(y, endM) }),
            endY: y,
            endM,
          });
        }
      }
      break;

    case 'annual':
      for (let y = fromYear; y <= toYear; y++) {
        out.push({
          key: `${y}`,
          start: toIso({ y, m: 1, d: 1 }),
          end: toIso({ y, m: 12, d: 31 }),
          endY: y,
          endM: 12,
        });
      }
      break;

    case 'once':
      out.push({ key: 'once', endY: fromYear, endM: 1 });
      break;
  }

  return out;
}

function dueDateFor(
  def: ObligationDef,
  period: Period,
  holidays: HolidayPack,
  packId?: string,
): IsoDate | undefined {
  const spec = def.schedule.due;

  switch (spec.rule) {
    case 'fixed_date':
      return spec.date;

    case 'last_business_day_of_month': {
      const { y, m } = addMonths(period.endY, period.endM, spec.months_after_period_end ?? 1);
      return lastBusinessDayOfMonth(y, m, holidays, packId);
    }

    case 'day_of_month': {
      const { y, m } = addMonths(period.endY, period.endM, spec.months_after_period_end ?? 1);
      // A `day` past the end of a short month means "end of month".
      const day = Math.min(spec.day ?? 1, lastDayOfMonth(y, m));
      return rollForward(toIso({ y, m, d: day }), holidays, packId);
    }

    case 'fixed_day_in_year': {
      const y = period.endY + (spec.years_after_period_end ?? 0);
      const m = spec.month ?? 1;
      const day = Math.min(spec.day ?? 1, lastDayOfMonth(y, m));
      return rollForward(toIso({ y, m, d: day }), holidays, packId);
    }

    default:
      return undefined;
  }
}

/**
 * All obligation instances with a due date inside `[from, to]`.
 *
 * `today` drives `days_until_due` and is passed in rather than read from the
 * clock so that this stays a pure function and can be tested.
 */
export function resolveInstances(args: {
  obligations: ObligationDef[];
  profile: Profile;
  holidays: HolidayPack;
  from: IsoDate;
  to: IsoDate;
  today: IsoDate;
  packId?: string;
}): ObligationInstance[] {
  const { obligations, profile, holidays, from, to, today, packId } = args;
  const fromYear = parseIso(from).y;
  const toYear = parseIso(to).y;

  const out: ObligationInstance[] = [];

  for (const def of obligations) {
    if (!appliesTo(def, profile)) continue;

    // Periods can precede their due date by a year (annual returns), so widen
    // the period search window and filter on the resulting due date instead.
    for (const period of periodsFor(def, fromYear - 2, toYear + 1)) {
      const due = dueDateFor(def, period, holidays, packId);
      if (!due) continue;
      if (due < from || due > to) continue;

      out.push({
        instance_id: `${def.id}:${period.key}`,
        obligation_id: def.id,
        name: def.name,
        name_en: def.name_en,
        category: def.category,
        owner: def.owner,
        period_key: period.key,
        period_start: period.start,
        period_end: period.end,
        due_date: due,
        days_until_due: daysBetween(today, due),
        reminders: def.reminders ?? [30, 14, 7, 3, 1],
        often_extended: def.often_extended,
        penalty_if_late: def.penalty_if_late,
        what_you_must_supply: def.what_you_must_supply,
        action_required: def.action_required,
        needs_verification: def.needs_verification,
        confidence: def.confidence,
        source: def.source,
      });
    }
  }

  out.sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
  return out;
}

/**
 * Is an instance at a reminder threshold today?
 *
 * Returns the threshold that fired, so the agent can escalate its tone: a
 * 30-day heads-up and a 1-day "this is due tomorrow and nobody has confirmed
 * it" are not the same message.
 */
export function reminderDue(instance: ObligationInstance): number | undefined {
  if (instance.days_until_due < 0) return 0;
  return instance.reminders.find((r) => r === instance.days_until_due);
}
