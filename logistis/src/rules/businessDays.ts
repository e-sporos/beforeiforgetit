/**
 * Calendar arithmetic for deadline resolution.
 *
 * All functions take and return ISO `YYYY-MM-DD` strings and work in UTC
 * internally. No local timezone ever enters the calculation, which is the
 * whole point — a deadline is a calendar date, not an instant.
 */

import type { HolidayPack, IsoDate } from '../types.js';

export interface Ymd {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

export function parseIso(iso: IsoDate): Ymd {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) throw new Error(`Not an ISO date (YYYY-MM-DD): ${iso}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

export function toIso({ y, m, d }: Ymd): IsoDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function toUtc(iso: IsoDate): number {
  const { y, m, d } = parseIso(iso);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): IsoDate {
  const dt = new Date(ms);
  return toIso({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  return fromUtc(toUtc(iso) + days * 86_400_000);
}

/** Positive when `b` is after `a`. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(iso: IsoDate): number {
  return new Date(toUtc(iso)).getUTCDay();
}

export function isWeekend(iso: IsoDate): boolean {
  const dow = dayOfWeek(iso);
  return dow === 0 || dow === 6;
}

export function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Add months to a year/month pair, normalising the year. */
export function addMonths(y: number, m: number, months: number): { y: number; m: number } {
  const zero = y * 12 + (m - 1) + months;
  return { y: Math.floor(zero / 12), m: (zero % 12) + 1 };
}

/**
 * Orthodox (Eastern) Easter Sunday, as a Gregorian calendar date.
 *
 * Meeus's Julian algorithm gives the date in the Julian calendar; adding 13
 * days converts to Gregorian. That 13-day offset holds for 1900–2099, which
 * comfortably covers any business this tool will ever track.
 */
export function orthodoxEaster(year: number): IsoDate {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  return addDays(toIso({ y: year, m: month, d: day }), 13);
}

export interface Holiday {
  date: IsoDate;
  name: string;
  name_en?: string;
}

const holidayCache = new Map<string, Map<IsoDate, Holiday>>();

/** All public holidays in a given year, fixed and Easter-derived. */
export function holidaysForYear(year: number, pack: HolidayPack, packId = 'default'): Map<IsoDate, Holiday> {
  const cacheKey = `${packId}:${year}`;
  const cached = holidayCache.get(cacheKey);
  if (cached) return cached;

  const out = new Map<IsoDate, Holiday>();

  for (const h of pack.fixed ?? []) {
    const date = toIso({ y: year, m: h.month, d: h.day });
    out.set(date, { date, name: h.name, name_en: h.name_en });
  }

  const easter = orthodoxEaster(year);
  for (const h of pack.movable ?? []) {
    const date = addDays(easter, h.offset);
    out.set(date, { date, name: h.name, name_en: h.name_en });
  }

  holidayCache.set(cacheKey, out);
  return out;
}

export function holidayOn(iso: IsoDate, pack: HolidayPack, packId?: string): Holiday | undefined {
  const { y } = parseIso(iso);
  return holidaysForYear(y, pack, packId).get(iso);
}

export function isBusinessDay(iso: IsoDate, pack: HolidayPack, packId?: string): boolean {
  return !isWeekend(iso) && !holidayOn(iso, pack, packId);
}

/** The first business day on or after `iso`. */
export function rollForward(iso: IsoDate, pack: HolidayPack, packId?: string): IsoDate {
  let cursor = iso;
  // 30 is far more than any real run of consecutive non-working days.
  for (let i = 0; i < 30; i++) {
    if (isBusinessDay(cursor, pack, packId)) return cursor;
    cursor = addDays(cursor, 1);
  }
  throw new Error(`No business day found within 30 days of ${iso}`);
}

/** The last business day on or before `iso`. */
export function rollBackward(iso: IsoDate, pack: HolidayPack, packId?: string): IsoDate {
  let cursor = iso;
  for (let i = 0; i < 30; i++) {
    if (isBusinessDay(cursor, pack, packId)) return cursor;
    cursor = addDays(cursor, -1);
  }
  throw new Error(`No business day found within 30 days before ${iso}`);
}

export function lastBusinessDayOfMonth(y: number, m: number, pack: HolidayPack, packId?: string): IsoDate {
  return rollBackward(toIso({ y, m, d: lastDayOfMonth(y, m) }), pack, packId);
}

/** Today in Europe/Athens, regardless of where the process is running. */
export function todayInZone(timezone = 'Europe/Athens'): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  // en-CA formats as YYYY-MM-DD.
  return parts;
}
