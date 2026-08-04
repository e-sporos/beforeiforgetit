/**
 * Compliance status and accountant accountability.
 *
 * The second half of this file exists because of a specific, common failure:
 * you cannot tell whether your accountant is doing their job, because nothing
 * is written down. You remember the penalty; you do not remember that you sent
 * the invoices on the 3rd and heard nothing back before the 30th.
 *
 * So: every obligation has an `owner`, every filing gets a record, every
 * request to the accountant gets logged with the date you needed an answer.
 * The scorecard is then just arithmetic — and arithmetic is much easier to
 * raise in a conversation than a feeling.
 */

import type { FilingRecord, Handoff, IsoDate, Profile } from '../types.js';
import type { ObligationInstance } from '../rules/schedule.js';
import { daysBetween } from '../rules/businessDays.js';

export type InstanceState =
  | 'done'
  | 'missed'
  | 'at_risk'
  | 'upcoming'
  | 'scheduled'
  | 'not_applicable'
  /** Fell due before this tool started tracking — reported, but not counted against anyone. */
  | 'before_tracking';

export interface InstanceStatus extends ObligationInstance {
  state: InstanceState;
  filing?: FilingRecord;
  /** Present for `missed` and `at_risk` — what to actually do about it. */
  recommended_action?: string;
}

const DONE: ReadonlySet<string> = new Set(['submitted', 'paid', 'confirmed']);

export function classify(
  instance: ObligationInstance,
  filing: FilingRecord | undefined,
  today: IsoDate,
  trackingSince?: IsoDate,
): InstanceStatus {
  const daysUntil = daysBetween(today, instance.due_date);
  const base: InstanceStatus = { ...instance, days_until_due: daysUntil, filing, state: 'scheduled' };

  if (filing?.status === 'not_applicable') return { ...base, state: 'not_applicable' };
  if (filing && DONE.has(filing.status)) return { ...base, state: 'done' };

  // Anything that fell due before tracking began is history this tool never
  // watched. Surface it so it can be back-filled, but never call it "missed" —
  // that would be an accusation the records cannot support.
  if (trackingSince && instance.due_date < trackingSince) {
    return {
      ...base,
      state: 'before_tracking',
      recommended_action:
        `Fell due on ${instance.due_date}, before tracking started on ${trackingSince}. ` +
        `If you want history in the scorecard, ask your accountant for the submission reference and record it with obligation_record.`,
    };
  }

  if (daysUntil < 0) {
    return {
      ...base,
      state: 'missed',
      recommended_action:
        instance.owner === 'accountant'
          ? `Overdue by ${Math.abs(daysUntil)} day(s) and not confirmed as filed. Ask your accountant today, in writing, for the submission reference. If it was filed, record it. If it was not, ask what the penalty exposure is and who is covering it.`
          : `Overdue by ${Math.abs(daysUntil)} day(s). Do this now, then record it — late filings usually get cheaper the sooner they are fixed.`,
    };
  }

  const threshold = Math.max(...instance.reminders, 0);
  if (daysUntil <= 3) {
    return {
      ...base,
      state: 'at_risk',
      recommended_action:
        instance.owner === 'accountant'
          ? `Due in ${daysUntil} day(s) with no confirmation on file. Chase for a yes/no answer today — not "it's handled", but the submission reference.`
          : `Due in ${daysUntil} day(s). ${instance.what_you_must_supply ?? 'Complete it and record the reference.'}`,
    };
  }
  if (daysUntil <= threshold) {
    return {
      ...base,
      state: 'upcoming',
      recommended_action: instance.what_you_must_supply
        ? `Send what is needed now rather than at the deadline: ${instance.what_you_must_supply}`
        : undefined,
    };
  }

  return base;
}

export interface ComplianceReport {
  as_of: IsoDate;
  window: { from: IsoDate; to: IsoDate };
  missed: InstanceStatus[];
  at_risk: InstanceStatus[];
  upcoming: InstanceStatus[];
  scheduled: InstanceStatus[];
  done: InstanceStatus[];
  before_tracking: InstanceStatus[];
  headline: string;
}

export function buildComplianceReport(args: {
  instances: ObligationInstance[];
  filings: FilingRecord[];
  today: IsoDate;
  from: IsoDate;
  to: IsoDate;
  trackingSince?: IsoDate;
}): ComplianceReport {
  const byInstance = new Map(args.filings.map((f) => [f.instance_id, f]));
  const classified = args.instances.map((i) =>
    classify(i, byInstance.get(i.instance_id), args.today, args.trackingSince),
  );

  const pick = (state: InstanceState) => classified.filter((c) => c.state === state);
  const missed = pick('missed');
  const atRisk = pick('at_risk');

  const headline =
    missed.length > 0
      ? `${missed.length} obligation(s) are overdue with no confirmation on file.`
      : atRisk.length > 0
        ? `Nothing is overdue, but ${atRisk.length} obligation(s) are due within 3 days and unconfirmed.`
        : 'Nothing overdue and nothing due in the next 3 days.';

  return {
    as_of: args.today,
    window: { from: args.from, to: args.to },
    missed,
    at_risk: atRisk,
    upcoming: pick('upcoming'),
    scheduled: pick('scheduled'),
    done: pick('done'),
    before_tracking: pick('before_tracking'),
    headline,
  };
}

// ---------------------------------------------------------------------------
// Accountant scorecard
// ---------------------------------------------------------------------------

export interface AccountantScorecard {
  window: { from: IsoDate; to: IsoDate };
  accountant?: string;
  tracking_since?: IsoDate;
  obligations_they_own: number;
  filed_on_time: number;
  filed_late: number;
  overdue_unconfirmed: number;
  never_confirmed: number;
  /** Owned by them but due before tracking began — excluded from the counts above. */
  outside_tracking_window: number;
  /** Requests you sent that passed their response deadline with no reply. */
  unanswered_requests: {
    id: string;
    date: IsoDate;
    subject: string;
    response_needed_by?: IsoDate;
    days_waiting: number;
  }[];
  estimated_penalty_exposure_note: string;
  summary: string;
  evidence_note: string;
}

export function buildAccountantScorecard(args: {
  instances: ObligationInstance[];
  filings: FilingRecord[];
  handoffs: Handoff[];
  profile: Profile;
  today: IsoDate;
  from: IsoDate;
  to: IsoDate;
}): AccountantScorecard {
  const byInstance = new Map(args.filings.map((f) => [f.instance_id, f]));

  // Obligations the accountant owns, either by the pack's default or because
  // you explicitly assigned them in your profile.
  const assigned = new Set(args.profile.accountant?.responsible_for ?? []);
  const theirs = args.instances.filter(
    (i) => i.owner === 'accountant' || assigned.has(i.obligation_id),
  );

  const trackingSince = args.profile.tracking_since;

  let onTime = 0;
  let late = 0;
  let overdueUnconfirmed = 0;
  let neverConfirmed = 0;
  let outsideWindow = 0;

  for (const instance of theirs) {
    const filing = byInstance.get(instance.instance_id);
    if (filing?.status === 'not_applicable') continue;

    if (filing && DONE.has(filing.status)) {
      if (filing.completed_on && filing.completed_on > instance.due_date) late += 1;
      else onTime += 1;
      continue;
    }

    // Unrecorded and due before tracking began: not evidence of anything.
    if (trackingSince && instance.due_date < trackingSince) {
      outsideWindow += 1;
      continue;
    }

    if (daysBetween(args.today, instance.due_date) < 0) {
      overdueUnconfirmed += 1;
      neverConfirmed += 1;
    }
  }

  const unanswered = args.handoffs
    .filter((h) => h.direction === 'sent' && !h.responded_on)
    .filter((h) => !h.response_needed_by || h.response_needed_by < args.today)
    .map((h) => ({
      id: h.id,
      date: h.date,
      subject: h.subject,
      response_needed_by: h.response_needed_by,
      days_waiting: daysBetween(h.date, args.today),
    }))
    .sort((a, b) => b.days_waiting - a.days_waiting);

  const assessed = theirs.length - outsideWindow;
  const summary =
    theirs.length === 0
      ? 'No obligations in this window are assigned to your accountant.'
      : assessed === 0
        ? `All ${theirs.length} obligation(s) your accountant owns in this window fell due before tracking started on ${trackingSince}. There is nothing to judge yet — the scorecard becomes meaningful from the next deadline onward.`
        : `Of ${assessed} obligation(s) assessed: ${onTime} confirmed on time, ${late} confirmed late, ${overdueUnconfirmed} overdue with no confirmation. ${unanswered.length} request(s) from you are unanswered past their deadline.` +
          (outsideWindow > 0 ? ` A further ${outsideWindow} fell due before tracking started and are excluded.` : '');

  return {
    window: { from: args.from, to: args.to },
    accountant: args.profile.accountant?.name,
    tracking_since: trackingSince,
    obligations_they_own: theirs.length,
    filed_on_time: onTime,
    filed_late: late,
    overdue_unconfirmed: overdueUnconfirmed,
    never_confirmed: neverConfirmed,
    outside_tracking_window: outsideWindow,
    unanswered_requests: unanswered,
    estimated_penalty_exposure_note:
      'This tool does not compute penalty amounts — they depend on the specific filing, the delay, and the tax owed. ' +
      'Ask your accountant to quantify the exposure for each overdue item in writing.',
    summary,
    evidence_note:
      'These counts are only as good as the records behind them. An obligation shows as "overdue, unconfirmed" when ' +
      'nobody recorded a submission reference — which may mean it was filed and never reported back to you. ' +
      'The fix in both cases is the same: ask for the reference and record it.',
  };
}
