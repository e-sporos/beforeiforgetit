/**
 * Persistence.
 *
 * Plain JSON files in a directory you own, not a database. Reasons:
 *
 *   1. These are your books. You should be able to open them in a text editor,
 *      diff them, grep them, and keep them in a private git repo. A binary
 *      database file gives you none of that.
 *   2. A one-person design business generates a few hundred documents a year.
 *      There is no scale problem to solve here.
 *   3. Zero native dependencies means `npm install` works on every machine.
 *
 * Writes are atomic (write to a temp file, then rename) so an interrupted run
 * cannot leave you with a truncated ledger.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  DetectedChange,
  Expense,
  FilingRecord,
  Handoff,
  Invoice,
  Profile,
  SourceSnapshot,
} from './types.js';

export function dataDir(): string {
  const override = process.env.LOGISTIS_DATA_DIR;
  if (override) return resolve(override);
  return join(homedir(), '.logistis');
}

function ensureDir(): string {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function filePath(name: string): string {
  return join(ensureDir(), `${name}.json`);
}

function readJson<T>(name: string, fallback: T): T {
  const path = filePath(name);
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON (${(error as Error).message}). ` +
        `It has not been overwritten — fix or move the file, then retry.`,
    );
  }
}

function writeJson(name: string, value: unknown): void {
  const path = filePath(name);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export function readProfile(): Profile | undefined {
  return readJson<Profile | undefined>('profile', undefined);
}

export function writeProfile(profile: Profile): void {
  writeJson('profile', profile);
}

/**
 * The profile, or a clear error. Nothing else in the system can produce a
 * correct answer without knowing the shape of the business.
 */
export function requireProfile(): Profile {
  const profile = readProfile();
  if (!profile) {
    throw new Error(
      'No business profile has been set up yet. Call `profile_set` first — at minimum ' +
        'jurisdiction, legal_form, books and vat_status. Without it, no deadline or ' +
        'estimate can be computed correctly.',
    );
  }
  return profile;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export const invoices = collection<Invoice>('invoices');
export const expenses = collection<Expense>('expenses');
export const handoffs = collection<Handoff>('handoffs');
export const changes = collection<DetectedChange>('rule_changes');

function collection<T extends { id: string }>(name: string) {
  return {
    all(): T[] {
      return readJson<T[]>(name, []);
    },
    get(id: string): T | undefined {
      return readJson<T[]>(name, []).find((item) => item.id === id);
    },
    add(item: T): T {
      const items = readJson<T[]>(name, []);
      items.push(item);
      writeJson(name, items);
      return item;
    },
    update(id: string, patch: Partial<T>): T {
      const items = readJson<T[]>(name, []);
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) throw new Error(`No ${name} record with id "${id}".`);
      const merged = { ...items[index], ...patch, id } as T;
      items[index] = merged;
      writeJson(name, items);
      return merged;
    },
    remove(id: string): void {
      const items = readJson<T[]>(name, []);
      writeJson(name, items.filter((item) => item.id !== id));
    },
  };
}

// ---------------------------------------------------------------------------
// Filings — keyed by instance id rather than a generated id, because an
// obligation instance is unique by (obligation, period) and we want repeated
// updates to overwrite rather than accumulate.
// ---------------------------------------------------------------------------

export const filings = {
  all(): FilingRecord[] {
    return readJson<FilingRecord[]>('filings', []);
  },
  get(instanceId: string): FilingRecord | undefined {
    return readJson<FilingRecord[]>('filings', []).find((f) => f.instance_id === instanceId);
  },
  upsert(record: FilingRecord): FilingRecord {
    const items = readJson<FilingRecord[]>('filings', []);
    const index = items.findIndex((f) => f.instance_id === record.instance_id);
    const merged = index === -1 ? record : { ...items[index], ...record };
    if (index === -1) items.push(merged);
    else items[index] = merged;
    writeJson('filings', items);
    return merged;
  },
};

// ---------------------------------------------------------------------------
// Watch snapshots
// ---------------------------------------------------------------------------

export const snapshots = {
  all(): Record<string, SourceSnapshot> {
    return readJson<Record<string, SourceSnapshot>>('source_snapshots', {});
  },
  get(sourceId: string): SourceSnapshot | undefined {
    return this.all()[sourceId];
  },
  put(snapshot: SourceSnapshot): void {
    const all = this.all();
    all[snapshot.source_id] = snapshot;
    writeJson('source_snapshots', all);
  },
};
