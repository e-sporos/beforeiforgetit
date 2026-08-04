/**
 * Loading jurisdiction packs and reading parameters out of them.
 *
 * The central idea: a parameter read is never just a number. It is a number
 * plus where it came from, when someone last checked it, and whether that
 * check has expired. Callers are expected to carry the provenance through to
 * the user rather than dropping it.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import type {
  DatedValue,
  HolidayPack,
  IsoDate,
  JurisdictionPack,
  ParameterDef,
} from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where jurisdiction packs live.
 *
 * `LOGISTIS_JURISDICTIONS_DIR` lets you point at a fork of the packs without
 * forking the code — the intended path for someone maintaining rules for a
 * country this repo does not ship yet.
 */
export function jurisdictionsDir(): string {
  const override = process.env.LOGISTIS_JURISDICTIONS_DIR;
  if (override) return resolve(override);
  // dist/rules/pack.js -> ../../jurisdictions
  return resolve(here, '..', '..', 'jurisdictions');
}

export interface LoadedPack {
  pack: JurisdictionPack;
  holidays: HolidayPack;
  path: string;
}

const packCache = new Map<string, LoadedPack>();

export function loadPack(jurisdictionId: string): LoadedPack {
  const cached = packCache.get(jurisdictionId);
  if (cached) return cached;

  const base = join(jurisdictionsDir(), jurisdictionId);
  const packPath = join(base, 'pack.yaml');
  const holidaysPath = join(base, 'holidays.yaml');

  if (!existsSync(packPath)) {
    throw new Error(
      `No jurisdiction pack for "${jurisdictionId}" at ${packPath}. ` +
        `Available packs live in ${jurisdictionsDir()}. ` +
        `To add one, copy jurisdictions/gr and work through it — see CONTRIBUTING.md.`,
    );
  }

  const pack = parseYaml(readFileSync(packPath, 'utf8')) as JurisdictionPack;
  const holidays: HolidayPack = existsSync(holidaysPath)
    ? (parseYaml(readFileSync(holidaysPath, 'utf8')) as HolidayPack)
    : { fixed: [], movable: [] };

  // YAML parses unquoted dates into Date objects; normalise them back to the
  // ISO strings the rest of the codebase expects.
  normaliseDates(pack);

  const loaded: LoadedPack = { pack, holidays, path: packPath };
  packCache.set(jurisdictionId, loaded);
  return loaded;
}

function normaliseDates(node: unknown): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const child = node[i];
      if (child instanceof Date) node[i] = child.toISOString().slice(0, 10);
      else normaliseDates(child);
    }
    return;
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const child = record[key];
      if (child instanceof Date) record[key] = child.toISOString().slice(0, 10);
      else normaliseDates(child);
    }
  }
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface ResolvedParameter<T = unknown> {
  name: string;
  label: string;
  unit: string;
  value: T | undefined;
  effective_from?: IsoDate;
  source?: string;
  verified_on?: IsoDate;
  review_by?: IsoDate;
  confidence?: string;
  /** Human-readable problems with this value. Never silently swallowed. */
  warnings: string[];
  notes?: string;
}

/**
 * The parameter value in force on `asOf`, with every reason to distrust it
 * attached.
 */
export function resolveParameter<T = unknown>(
  pack: JurisdictionPack,
  name: string,
  asOf: IsoDate,
  today: IsoDate,
): ResolvedParameter<T> {
  const def: ParameterDef | undefined = pack.parameters?.[name];
  if (!def) {
    return {
      name,
      label: name,
      unit: 'unknown',
      value: undefined,
      warnings: [`Parameter "${name}" is not defined in the ${pack.id} pack.`],
    };
  }

  const warnings: string[] = [];

  // Latest value whose effective_from is on or before asOf.
  const applicable = (def.values ?? [])
    .filter((v: DatedValue) => !v.effective_from || v.effective_from <= asOf)
    .sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
  const chosen = applicable[applicable.length - 1];

  if (!chosen) {
    warnings.push(
      def.warning
        ? `No value available. ${def.warning.trim()}`
        : `No value defined for "${name}" as of ${asOf}. This must be supplied before any figure using it can be trusted.`,
    );
  }

  if (def.needs_verification) {
    warnings.push(`"${def.label}" is flagged as needing verification against ${def.source ?? 'the official source'}.`);
  }
  if (def.confidence === 'low') {
    warnings.push(`"${def.label}" is recorded with LOW confidence — verify before relying on it.`);
  }
  if (def.review_by && def.review_by < today) {
    warnings.push(
      `"${def.label}" was due for review on ${def.review_by} (last verified ${def.verified_on ?? 'never'}). ` +
        `It is now ${today}. Treat this value as stale until re-checked against ${def.source ?? 'the official source'}.`,
    );
  }
  if (def.warning && chosen) {
    warnings.push(def.warning.trim());
  }

  return {
    name,
    label: def.label,
    unit: def.unit,
    value: chosen?.value as T | undefined,
    effective_from: chosen?.effective_from,
    source: def.source,
    verified_on: def.verified_on,
    review_by: def.review_by,
    confidence: def.confidence,
    warnings,
    notes: def.notes,
  };
}

/** Everything in the pack that is stale, low-confidence, or unverified. */
export function packHealth(pack: JurisdictionPack, today: IsoDate) {
  const stale: string[] = [];
  const unverified: string[] = [];

  const check = (label: string, item: { review_by?: IsoDate; needs_verification?: boolean; confidence?: string }) => {
    if (item.review_by && item.review_by < today) stale.push(`${label} (review was due ${item.review_by})`);
    if (item.needs_verification || item.confidence === 'low') unverified.push(label);
  };

  for (const [name, def] of Object.entries(pack.parameters ?? {})) check(`parameter:${name}`, def);
  for (const def of pack.obligations ?? []) check(`obligation:${def.id}`, def);

  return {
    pack_id: pack.id,
    pack_version: pack.meta?.pack_version,
    last_reviewed: pack.meta?.last_reviewed,
    stale,
    unverified,
    healthy: stale.length === 0 && unverified.length === 0,
    disclaimer: pack.meta?.disclaimer,
  };
}
